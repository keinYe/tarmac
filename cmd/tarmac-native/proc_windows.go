//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsSystem struct{}

func (windowsSystem) snapshot() ([]process, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	var processes []process
	for err = windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		if entry.ProcessID == 0 {
			continue
		}
		processes = append(processes, process{
			Pid:       entry.ProcessID,
			Ppid:      entry.ParentProcessID,
			Name:      windows.UTF16ToString(entry.ExeFile[:]),
			StartedAt: startedAt(entry.ProcessID),
		})
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return nil, err
	}
	return processes, nil
}

// startedAt is part of a process's identity: the daemon drops parent links that point to a
// reused PID by comparing it.
func startedAt(pid uint32) int64 {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return 0
	}
	defer windows.CloseHandle(handle)
	var creation, exit, kernel, user windows.Filetime
	if windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user) != nil {
		return 0
	}
	return creation.Nanoseconds() / 1e6
}

func (windowsSystem) inspect(pid uint32) detail {
	result := detail{Pid: pid}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return result
	}
	result.Executable = imagePath(handle)
	result.Argv = commandLine(handle)
	windows.CloseHandle(handle)
	result.Cwd = currentDirectory(pid)
	return result
}

func imagePath(handle windows.Handle) string {
	buffer := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buffer))
	if windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size) != nil {
		return ""
	}
	return windows.UTF16ToString(buffer[:size])
}

// commandLine needs only limited query access (Windows 8.1 and later).
func commandLine(handle windows.Handle) []string {
	var size uint32
	_ = windows.NtQueryInformationProcess(handle, windows.ProcessCommandLineInformation, nil, 0, &size)
	if size < 16 || size > 1<<20 {
		return nil
	}
	buffer := make([]byte, size)
	if windows.NtQueryInformationProcess(handle, windows.ProcessCommandLineInformation, unsafe.Pointer(&buffer[0]), size, &size) != nil {
		return nil
	}
	// The reply is a UNICODE_STRING whose Buffer points into the same allocation.
	length := uintptr(binary.LittleEndian.Uint16(buffer[0:]))
	offset := uintptr(binary.LittleEndian.Uint64(buffer[8:])) - uintptr(unsafe.Pointer(&buffer[0]))
	if length == 0 || length%2 != 0 || offset+length > uintptr(len(buffer)) {
		return nil
	}
	text := windows.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(&buffer[offset])), length/2))
	argv, err := windows.DecomposeCommandLine(text)
	if err != nil {
		return nil
	}
	return argv
}

// x64 layouts. Remote structures are read into byte buffers rather than x/sys types, whose
// pointer fields would hold foreign addresses the Go garbage collector could misread.
const (
	pebProcessParameters = 0x20
	paramsCurrentDir     = 0x38 // CURDIR.DosPath, a UNICODE_STRING
)

// currentDirectory reads the PEB of a same-user, 64-bit process. Other processes return "".
func currentDirectory(pid uint32) string {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_VM_READ, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(handle)
	var wow64 bool
	if windows.IsWow64Process(handle, &wow64) != nil || wow64 {
		return ""
	}
	// PROCESS_BASIC_INFORMATION: ExitStatus, PebBaseAddress, AffinityMask, BasePriority,
	// UniqueProcessId, InheritedFromUniqueProcessId; each occupies 8 bytes on x64.
	var basic [6]uintptr
	if windows.NtQueryInformationProcess(handle, windows.ProcessBasicInformation, unsafe.Pointer(&basic[0]), uint32(unsafe.Sizeof(basic)), nil) != nil {
		return ""
	}
	params, ok := readPointer(handle, basic[1]+pebProcessParameters)
	if !ok {
		return ""
	}
	var header [16]byte
	if !read(handle, params+paramsCurrentDir, header[:]) {
		return ""
	}
	length := int(binary.LittleEndian.Uint16(header[0:]))
	address := uintptr(binary.LittleEndian.Uint64(header[8:]))
	if length == 0 || length%2 != 0 || length > 2*windows.MAX_LONG_PATH {
		return ""
	}
	raw := make([]byte, length)
	if !read(handle, address, raw) {
		return ""
	}
	units := make([]uint16, length/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(raw[2*i:])
	}
	path := windows.UTF16ToString(units)
	// The DOS path keeps a trailing separator except at a drive root.
	if len(path) > 3 {
		path = strings.TrimSuffix(path, `\`)
	}
	return path
}

func readPointer(handle windows.Handle, address uintptr) (uintptr, bool) {
	var raw [8]byte
	if !read(handle, address, raw[:]) {
		return 0, false
	}
	value := uintptr(binary.LittleEndian.Uint64(raw[:]))
	return value, value != 0
}

func read(handle windows.Handle, address uintptr, buffer []byte) bool {
	if address == 0 || len(buffer) == 0 {
		return false
	}
	var done uintptr
	return windows.ReadProcessMemory(handle, address, &buffer[0], uintptr(len(buffer)), &done) == nil && done == uintptr(len(buffer))
}
