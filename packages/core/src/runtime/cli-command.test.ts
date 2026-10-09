import { describe, expect, it } from "vitest";
import { resolveCliCommand } from "./cli-command.js";

function fs(files: Record<string, string>) {
  const lower = new Map(Object.entries(files).map(([path, text]) => [path.toLowerCase(), text]));
  return {
    isFile: (path: string) => lower.has(path.toLowerCase()),
    readText: (path: string) => {
      const text = lower.get(path.toLowerCase());
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  };
}

const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join("\r\n");

describe("resolveCliCommand — Windows", () => {
  it("uses a native claude.exe directly", () => {
    const resolved = resolveCliCommand("claude", {
      platform: "win32",
      env: { Path: "C:\\Tools;C:\\Users\\me\\.local\\bin" },
      ...fs({ "C:\\Users\\me\\.local\\bin\\claude.exe": "" }),
    });
    expect(resolved).toEqual({ command: "C:\\Users\\me\\.local\\bin\\claude.exe", prefixArgs: [] });
  });

  it("unwraps an npm .cmd shim to node + the CLI entry point instead of using a shell", () => {
    const resolved = resolveCliCommand("claude", {
      platform: "win32",
      env: { PATH: "C:\\npm;C:\\nodejs" },
      ...fs({
        "C:\\npm\\claude.cmd": NPM_SHIM,
        "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js": "",
        "C:\\nodejs\\node.exe": "",
      }),
    });
    expect(resolved).toEqual({
      command: "C:\\nodejs\\node.exe",
      prefixArgs: ["C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"],
    });
  });

  it("prefers a node.exe next to the shim, as the shim itself does", () => {
    const resolved = resolveCliCommand("claude", {
      platform: "win32",
      env: { PATH: "C:\\npm;C:\\nodejs" },
      ...fs({
        "C:\\npm\\claude.cmd": NPM_SHIM,
        "C:\\npm\\node.exe": "",
        "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js": "",
        "C:\\nodejs\\node.exe": "",
      }),
    });
    expect(resolved?.command).toBe("C:\\npm\\node.exe");
  });

  it("follows a shim that forwards to a native binary", () => {
    const resolved = resolveCliCommand("claude", {
      platform: "win32",
      env: { PATH: "C:\\npm" },
      ...fs({
        "C:\\npm\\claude.cmd": '@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*',
        "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe": "",
      }),
    });
    expect(resolved).toEqual({ command: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe", prefixArgs: [] });
  });

  it("refuses a batch file it cannot unwrap rather than running it through cmd.exe", () => {
    const resolved = resolveCliCommand("claude", {
      platform: "win32",
      env: { PATH: "C:\\bin" },
      ...fs({ "C:\\bin\\claude.bat": "@echo off\r\ncall something-else %*" }),
    });
    expect(resolved).toBeUndefined();
  });

  it("honours PATH order across extensions", () => {
    const resolved = resolveCliCommand("claude", {
      platform: "win32",
      env: { PATH: "C:\\first;C:\\second" },
      ...fs({ "C:\\second\\claude.exe": "", "C:\\first\\claude.cmd": NPM_SHIM, "C:\\first\\node_modules\\@anthropic-ai\\claude-code\\cli.js": "", "C:\\first\\node.exe": "" }),
    });
    expect(resolved?.command).toBe("C:\\first\\node.exe");
  });

  it("returns undefined when claude is not installed", () => {
    expect(resolveCliCommand("claude", { platform: "win32", env: { PATH: "C:\\x" }, ...fs({}) })).toBeUndefined();
  });
});

describe("resolveCliCommand — POSIX", () => {
  it("searches PATH", () => {
    const resolved = resolveCliCommand("claude", {
      platform: "linux",
      env: { PATH: "/usr/bin:/home/me/.local/bin" },
      ...fs({ "/home/me/.local/bin/claude": "" }),
    });
    expect(resolved).toEqual({ command: "/home/me/.local/bin/claude", prefixArgs: [] });
  });

  it("returns undefined when claude is not on PATH", () => {
    expect(resolveCliCommand("claude", { platform: "darwin", env: { PATH: "/usr/bin" }, ...fs({}) })).toBeUndefined();
  });
});
