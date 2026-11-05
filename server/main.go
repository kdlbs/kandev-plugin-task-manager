// Command kandev-plugin-task-manager is a kandev plugin whose backend
// measures what each task's agent actually costs this machine, and relays the
// result to its native UI. Spawned by kandev over the gRPC plugin contract;
// pluginsdk.Serve owns the transport.
package main

import "github.com/kdlbs/kandev/pluginsdk"

func main() {
	pluginsdk.Serve(newPlugin())
}
