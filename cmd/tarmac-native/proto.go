// Command tarmac-native is Tarmac's Windows helper. It is built only for Windows; the protocol
// and path logic in this file stay platform neutral so they are tested on every host.
//
//	tarmac-native proc       answer process queries from the daemon as JSON lines on stdin/stdout
//	tarmac-native cli ARGS   run the packaged CLI (hooks, statusLine) on the bundled Electron
package main

import (
	"bufio"
	"encoding/json"
	"io"
	"path/filepath"
)

const maxPids = 4096

type request struct {
	ID   int64    `json:"id"`
	Op   string   `json:"op"`
	Pids []uint32 `json:"pids,omitempty"`
}

type process struct {
	Pid       uint32 `json:"pid"`
	Ppid      uint32 `json:"ppid"`
	Name      string `json:"name"`
	StartedAt int64  `json:"startedAt,omitempty"` // ms since the Unix epoch; 0 when not readable
}

type detail struct {
	Pid        uint32   `json:"pid"`
	Argv       []string `json:"argv,omitempty"`
	Cwd        string   `json:"cwd,omitempty"`
	Executable string   `json:"executable,omitempty"`
}

// A pointer keeps an empty process table as [] while other replies omit the field.
type reply struct {
	ID        int64      `json:"id"`
	Processes *[]process `json:"processes,omitempty"`
	Items     []detail   `json:"items,omitempty"`
	Error     string     `json:"error,omitempty"`
}

// system is the OS side; inspect returns what it can read and leaves the rest empty.
type system interface {
	snapshot() ([]process, error)
	inspect(pid uint32) detail
}

// serve answers one request per line until in closes, which happens when the daemon exits.
func serve(in io.Reader, out io.Writer, sys system) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	writer := bufio.NewWriter(out)
	encoder := json.NewEncoder(writer)
	for scanner.Scan() {
		var req request
		var res reply
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			res.Error = "invalid request"
		} else {
			res.ID = req.ID
			switch req.Op {
			case "snapshot":
				processes, err := sys.snapshot()
				if err != nil {
					res.Error = err.Error()
				} else {
					if processes == nil {
						processes = []process{}
					}
					res.Processes = &processes
				}
			case "inspect":
				if len(req.Pids) > maxPids {
					res.Error = "too many pids"
					break
				}
				res.Items = make([]detail, 0, len(req.Pids))
				for _, pid := range req.Pids {
					res.Items = append(res.Items, sys.inspect(pid))
				}
			default:
				res.Error = "unknown op"
			}
		}
		if err := encoder.Encode(res); err != nil {
			return err
		}
		if err := writer.Flush(); err != nil {
			return err
		}
	}
	return scanner.Err()
}

// launcherPaths locates the bundled Electron and CLI from this helper's packaged location
// <root>/resources/app/dist/native/tarmac-native.exe.
func launcherPaths(self string) (app, cli string) {
	native := filepath.Dir(self)
	dist := filepath.Dir(native)
	root := filepath.Dir(filepath.Dir(filepath.Dir(dist)))
	return filepath.Join(root, "Tarmac.exe"), filepath.Join(dist, "cli.cjs")
}
