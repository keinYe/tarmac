//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: tarmac-native proc | cli ARGS...")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "proc":
		if err := serve(os.Stdin, os.Stdout, windowsSystem{}); err != nil {
			os.Exit(1)
		}
	case "cli":
		os.Exit(runCLI(os.Args[2:]))
	default:
		fmt.Fprintln(os.Stderr, "usage: tarmac-native proc | cli ARGS...")
		os.Exit(2)
	}
}

// runCLI is the hook command agents invoke. A real executable behaves the same whether a hook
// runs through Git Bash, PowerShell or cmd, which a .cmd wrapper with its quoting does not.
func runCLI(args []string) int {
	self, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "tarmac-native: cannot locate itself")
		return 1
	}
	app, cli := launcherPaths(self)
	cmd := exec.Command(app, append([]string{cli}, args...)...)
	// exec keeps the last duplicate, so this wins over an inherited value.
	cmd.Env = append(os.Environ(), "ELECTRON_RUN_AS_NODE=1")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode()
		}
		fmt.Fprintln(os.Stderr, "tarmac-native: cannot start Tarmac")
		return 1
	}
	return 0
}
