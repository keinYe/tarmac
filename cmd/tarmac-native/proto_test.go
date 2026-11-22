package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

type fakeSystem struct {
	processes []process
	err       error
}

func (f fakeSystem) snapshot() ([]process, error) { return f.processes, f.err }
func (f fakeSystem) inspect(pid uint32) detail {
	if pid == 7 {
		return detail{Pid: pid, Argv: []string{"node", "cli.js"}, Cwd: `C:\work`}
	}
	return detail{Pid: pid}
}

func replies(t *testing.T, input string, sys system) []map[string]any {
	t.Helper()
	var out bytes.Buffer
	if err := serve(strings.NewReader(input), &out, sys); err != nil {
		t.Fatal(err)
	}
	var result []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var value map[string]any
		if err := json.Unmarshal([]byte(line), &value); err != nil {
			t.Fatalf("invalid reply %q: %v", line, err)
		}
		result = append(result, value)
	}
	return result
}

func TestServeAnswersEachRequestByID(t *testing.T) {
	sys := fakeSystem{processes: []process{{Pid: 7, Ppid: 1, Name: "node.exe", StartedAt: 5}}}
	got := replies(t, `{"id":1,"op":"snapshot"}`+"\n"+`{"id":2,"op":"inspect","pids":[7,8]}`+"\n", sys)
	if len(got) != 2 || got[0]["id"].(float64) != 1 || got[1]["id"].(float64) != 2 {
		t.Fatalf("replies = %v", got)
	}
	if processes := got[0]["processes"].([]any); len(processes) != 1 || processes[0].(map[string]any)["name"] != "node.exe" {
		t.Fatalf("snapshot = %v", got[0])
	}
	items := got[1]["items"].([]any)
	if len(items) != 2 || items[0].(map[string]any)["cwd"] != `C:\work` || items[1].(map[string]any)["cwd"] != nil {
		t.Fatalf("inspect = %v", got[1])
	}
}

func TestServeReportsErrorsWithoutStopping(t *testing.T) {
	got := replies(t, "not json\n"+`{"id":3,"op":"bogus"}`+"\n"+`{"id":4,"op":"snapshot"}`+"\n", fakeSystem{err: errors.New("denied")})
	if got[0]["error"] != "invalid request" || got[1]["error"] != "unknown op" || got[2]["error"] != "denied" || got[2]["id"].(float64) != 4 {
		t.Fatalf("replies = %v", got)
	}
}

func TestServeKeepsEmptySnapshotAnArray(t *testing.T) {
	got := replies(t, `{"id":1,"op":"snapshot"}`+"\n", fakeSystem{})
	if processes, ok := got[0]["processes"].([]any); !ok || len(processes) != 0 {
		t.Fatalf("snapshot = %v", got[0])
	}
}

func TestServeRejectsOversizedInspect(t *testing.T) {
	pids := make([]uint32, maxPids+1)
	line, _ := json.Marshal(request{ID: 9, Op: "inspect", Pids: pids})
	got := replies(t, string(line)+"\n", fakeSystem{})
	if got[0]["error"] != "too many pids" {
		t.Fatalf("reply = %v", got[0])
	}
}

func TestLauncherPathsFollowPackagedLayout(t *testing.T) {
	root := filepath.Join("pkg", "Tarmac-win32-x64")
	app, cli := launcherPaths(filepath.Join(root, "resources", "app", "dist", "native", "tarmac-native.exe"))
	if app != filepath.Join(root, "Tarmac.exe") || cli != filepath.Join(root, "resources", "app", "dist", "cli.cjs") {
		t.Fatalf("app = %s, cli = %s", app, cli)
	}
}
