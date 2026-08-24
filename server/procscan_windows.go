package main

import (
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

// windowsScanner reads the process table with a Toolhelp32 snapshot, CPU time
// with GetProcessTimes, memory with GetProcessMemoryInfo, and each process's
// environment out of its PEB via ReadProcessMemory.
//
// The environment is the awkward one: Windows offers no equivalent of
// /proc/<pid>/environ or KERN_PROCARGS2, so the only supported route is to
// follow the process's PEB to its RTL_USER_PROCESS_PARAMETERS and read the
// environment block out of the target's address space. That needs
// PROCESS_VM_READ, which a process of the same user and integrity level
// grants — kandev's agents run as the backend's own user, so the plugin
// qualifies. Where it does not (an elevated process, a 32-bit process under
// WOW64 whose PEB layout differs from this binary's), the read fails and the
// process simply inherits its parent's attribution instead.
//
// The struct offsets come from unsafe.Offsetof over x/sys/windows's own PEB
// and RTL_USER_PROCESS_PARAMETERS definitions rather than from hardcoded
// constants, so they stay correct without this file tracking layout changes.
type windowsScanner struct{}

func newScanner() procScanner { return &windowsScanner{} }

func (s *windowsScanner) platform() string { return "windows" }

// memoryStatusEx mirrors MEMORYSTATUSEX; x/sys/windows does not declare it.
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

var procGlobalMemoryStatusEx = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

// totalMemoryBytes reads TotalPhys from GlobalMemoryStatusEx.
func (s *windowsScanner) totalMemoryBytes() uint64 {
	var status memoryStatusEx
	status.Length = uint32(unsafe.Sizeof(status))
	ret, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status)))
	if ret == 0 {
		return 0
	}
	return status.TotalPhys
}

// filetimeToSeconds converts a FILETIME's 100-nanosecond ticks to seconds.
const filetimeTicksPerSecond = 1e7

func (s *windowsScanner) scan() ([]procSample, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snapshot)

	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Process32First(snapshot, &entry); err != nil {
		return nil, err
	}

	var samples []procSample
	for {
		if sample, ok := sampleFromEntry(&entry); ok {
			samples = append(samples, sample)
		}
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			// ERROR_NO_MORE_FILES ends the walk; anything else ends it too,
			// with whatever was collected so far.
			break
		}
	}
	return samples, nil
}

func sampleFromEntry(entry *windows.ProcessEntry32) (procSample, bool) {
	pid := int(entry.ProcessID)
	if pid == 0 {
		return procSample{}, false // the idle process is not a real process
	}
	sample := procSample{
		PID:  pid,
		PPID: int(entry.ParentProcessID),
		Name: windows.UTF16ToString(entry.ExeFile[:]),
	}

	// PROCESS_QUERY_LIMITED_INFORMATION is deliberately weaker than
	// PROCESS_QUERY_INFORMATION: it is granted for processes whose full
	// information is off limits, so CPU and memory still work for more of the
	// table than the environment read does.
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
	if err != nil {
		// Visible in the snapshot but not openable. Keep it: it still shows
		// up as a parent in the tree, it just carries no measurements.
		sample.StartKey = strconv.Itoa(pid) + ":?"
		return sample, true
	}
	defer windows.CloseHandle(handle)

	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user); err == nil {
		sample.CPUSeconds = float64(filetimeTicks(kernel)+filetimeTicks(user)) / filetimeTicksPerSecond
		// Creation time is what makes the identity stable across samples and
		// distinguishes a recycled PID from the process that held it before.
		sample.StartKey = strconv.Itoa(pid) + ":" + strconv.FormatUint(filetimeTicks(creation), 10)
	} else {
		sample.StartKey = strconv.Itoa(pid) + ":?"
	}
	sample.RSSBytes = workingSetBytes(handle)
	sample.Command = truncateCommand(sample.Name)
	return sample, true
}

func filetimeTicks(ft windows.Filetime) uint64 {
	return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime)
}

// psapi's GetProcessMemoryInfo is not declared by x/sys/windows, so it is
// bound here. PROCESS_MEMORY_COUNTERS is likewise declared locally.
var (
	psapi                    = windows.NewLazySystemDLL("psapi.dll")
	procGetProcessMemoryInfo = psapi.NewProc("GetProcessMemoryInfo")
)

type processMemoryCounters struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

// workingSetBytes is Windows's nearest equivalent of RSS: resident physical
// memory, shared pages included in every process that maps them. There is no
// cheap PSS equivalent, so a tree total reads high, and memoryBytes reports
// the basis as such.
func workingSetBytes(handle windows.Handle) uint64 {
	var counters processMemoryCounters
	counters.CB = uint32(unsafe.Sizeof(counters))
	ret, _, _ := procGetProcessMemoryInfo.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&counters)),
		uintptr(counters.CB),
	)
	if ret == 0 {
		return 0
	}
	return uint64(counters.WorkingSetSize)
}

func (s *windowsScanner) memoryBytes(_ int, rss uint64) (uint64, string) {
	return rss, basisRSS
}

// environChunk is how much of the environment block is read at a time.
// ReadProcessMemory fails outright if any part of the requested range is
// unmapped, so the block is walked a page at a time rather than requested in
// one large read that a short region would reject wholesale.
const environChunk = 4096

// environCap bounds the total read. Environments are a few kilobytes; the cap
// exists so a corrupt pointer cannot make the plugin read megabytes out of
// another process on every scan.
const environCap = 128 * 1024

func (s *windowsScanner) identity(pid int) (string, string, bool) {
	handle, err := windows.OpenProcess(
		windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_VM_READ, false, uint32(pid))
	if err != nil {
		return "", "", false
	}
	defer windows.CloseHandle(handle)

	address, ok := environAddress(handle)
	if !ok {
		return "", "", false
	}
	units, ok := readEnvironBlock(handle, address)
	if !ok {
		return "", "", false
	}
	return identityFromUTF16Environ(units)
}

// environAddress walks PEB -> ProcessParameters -> Environment in the target
// process, returning the address of its environment block.
func environAddress(handle windows.Handle) (uintptr, bool) {
	var pbi windows.PROCESS_BASIC_INFORMATION
	var returned uint32
	err := windows.NtQueryInformationProcess(
		handle,
		windows.ProcessBasicInformation,
		unsafe.Pointer(&pbi),
		uint32(unsafe.Sizeof(pbi)),
		&returned,
	)
	if err != nil || pbi.PebBaseAddress == nil {
		return 0, false
	}

	params, ok := readPointer(handle,
		uintptr(unsafe.Pointer(pbi.PebBaseAddress))+unsafe.Offsetof(windows.PEB{}.ProcessParameters))
	if !ok || params == 0 {
		return 0, false
	}
	environ, ok := readPointer(handle,
		params+unsafe.Offsetof(windows.RTL_USER_PROCESS_PARAMETERS{}.Environment))
	if !ok || environ == 0 {
		return 0, false
	}
	return environ, true
}

func readPointer(handle windows.Handle, address uintptr) (uintptr, bool) {
	var value uintptr
	var read uintptr
	err := windows.ReadProcessMemory(handle, address,
		(*byte)(unsafe.Pointer(&value)), unsafe.Sizeof(value), &read)
	if err != nil || read != unsafe.Sizeof(value) {
		return 0, false
	}
	return value, true
}

// readEnvironBlock reads the UTF-16 environment block a chunk at a time,
// stopping at the terminating empty entry, at the cap, or at the first chunk
// that cannot be read.
func readEnvironBlock(handle windows.Handle, address uintptr) ([]uint16, bool) {
	var units []uint16
	buffer := make([]byte, environChunk)
	for offset := 0; offset < environCap; offset += environChunk {
		var read uintptr
		err := windows.ReadProcessMemory(handle, address+uintptr(offset),
			&buffer[0], uintptr(len(buffer)), &read)
		if err != nil || read < 2 {
			break
		}
		units = append(units, utf16FromBytes(buffer[:read])...)
		if environBlockEnd(units) < len(units) {
			return units, true // terminator found
		}
	}
	// No terminator: a partial block is still worth parsing, since the
	// variables we want are usually well inside the first chunk.
	return units, len(units) > 0
}
