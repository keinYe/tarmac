//go:build !windows

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "tarmac-native is a Windows-only helper")
	os.Exit(2)
}
