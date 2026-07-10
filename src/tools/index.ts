// 工具集：每个工具 = JSON Schema（给模型）+ 本地执行函数。
// P1 版：Read / Write / Edit / Bash / Glob / Grep —— 覆盖"读代码、改文件、跑命令、搜索"。
import { promises as fs } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolResult } from "../types.js";

const pexec = promisify(exec);

function abs(ctx: ToolContext, p: string): string {
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

// ---- Read ----
const readTool: Tool = {
  name: "read_file",
  description: "读取文本文件内容，返回带行号的内容。用于查看代码/文件。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径（相对或绝对）" },
      offset: { type: "number", description: "起始行(1基)，可选" },
      limit: { type: "number", description: "读取行数，默认 2000" },
    },
    required: ["path"],
  },
  async run(input, ctx): Promise<ToolResult> {
    try {
      const raw = await fs.readFile(abs(ctx, String(input.path)), "utf8");
      const lines = raw.split("\n");
      const offset = Math.max(1, Number(input.offset ?? 1));
      const limit = Number(input.limit ?? 2000);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice
        .map((l, i) => `${String(offset + i).padStart(6)}\t${l}`)
        .join("\n");
      return { content: body || "(空文件)" };
    } catch (e: any) {
      return { content: `读取失败: ${e.message}`, isError: true };
    }
  },
};

// ---- Write ----
const writeTool: Tool = {
  name: "write_file",
  description: "写入/覆盖文件（不存在则创建，含父目录）。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async run(input, ctx): Promise<ToolResult> {
    try {
      const target = abs(ctx, String(input.path));
      await fs.mkdir(resolve(target, ".."), { recursive: true });
      await fs.writeFile(target, String(input.content), "utf8");
      return { content: `已写入 ${target}` };
    } catch (e: any) {
      return { content: `写入失败: ${e.message}`, isError: true };
    }
  },
};

// ---- Edit（精确字符串替换）----
const editTool: Tool = {
  name: "edit_file",
  description: "对文件做精确字符串替换。old_string 必须在文件中唯一出现，否则报错。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean", description: "替换全部出现，默认 false" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async run(input, ctx): Promise<ToolResult> {
    try {
      const target = abs(ctx, String(input.path));
      const raw = await fs.readFile(target, "utf8");
      const oldStr = String(input.old_string);
      const newStr = String(input.new_string);
      const count = raw.split(oldStr).length - 1;
      if (count === 0) return { content: "未找到 old_string，未修改", isError: true };
      if (count > 1 && !input.replace_all)
        return {
          content: `old_string 出现 ${count} 次不唯一；请加长上下文或设 replace_all`,
          isError: true,
        };
      const next = input.replace_all
        ? raw.split(oldStr).join(newStr)
        : raw.replace(oldStr, newStr);
      await fs.writeFile(target, next, "utf8");
      return { content: `已编辑 ${target}（替换 ${input.replace_all ? count : 1} 处）` };
    } catch (e: any) {
      return { content: `编辑失败: ${e.message}`, isError: true };
    }
  },
};

// ---- Bash ----
const bashTool: Tool = {
  name: "bash",
  description: "在工作目录执行 shell 命令（macOS/bash），返回 stdout+stderr。默认超时 120s。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_ms: { type: "number", description: "超时毫秒，默认 120000" },
    },
    required: ["command"],
  },
  async run(input, ctx): Promise<ToolResult> {
    try {
      const { stdout, stderr } = await pexec(String(input.command), {
        cwd: ctx.cwd,
        timeout: Number(input.timeout_ms ?? 120000),
        maxBuffer: 10 * 1024 * 1024,
        shell: "/bin/bash",
      });
      const out = [stdout, stderr].filter(Boolean).join("\n").trim();
      return { content: out || "(无输出)" };
    } catch (e: any) {
      const out = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
      return { content: out || `执行失败: ${e.message}`, isError: true };
    }
  },
};

// ---- Glob（文件名匹配，借 bash+find/ripgrep 更稳，这里用简单 find）----
const globTool: Tool = {
  name: "glob",
  description: "按 glob 模式查找文件（如 '**/*.ts'），返回匹配路径列表。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "搜索根目录，默认工作目录" },
    },
    required: ["pattern"],
  },
  async run(input, ctx): Promise<ToolResult> {
    try {
      const root = input.path ? abs(ctx, String(input.path)) : ctx.cwd;
      const results: string[] = [];
      const pattern = String(input.pattern);
      await walk(root, results, 20000);
      const rx = globToRegExp(pattern);
      const matched = results
        .map((p) => p.slice(root.length + 1))
        .filter((rel) => rx.test(rel))
        .slice(0, 500);
      return { content: matched.join("\n") || "(无匹配)" };
    } catch (e: any) {
      return { content: `glob 失败: ${e.message}`, isError: true };
    }
  },
};

// ---- Grep（内容搜索，优先用系统 grep -r）----
const grepTool: Tool = {
  name: "grep",
  description: "在文件内容中搜索正则/字符串，返回命中行（文件:行号:内容）。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "搜索目录/文件，默认工作目录" },
      glob: { type: "string", description: "限定文件类型，如 '*.ts'（可选）" },
    },
    required: ["pattern"],
  },
  async run(input, ctx): Promise<ToolResult> {
    const target = input.path ? abs(ctx, String(input.path)) : ctx.cwd;
    const include = input.glob ? `--include='${String(input.glob)}'` : "";
    const cmd = `grep -rniE ${include} -- ${shellQuote(String(input.pattern))} ${shellQuote(target)} | head -200`;
    try {
      const { stdout } = await pexec(cmd, {
        cwd: ctx.cwd,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
        shell: "/bin/bash",
      });
      return { content: stdout.trim() || "(无命中)" };
    } catch (e: any) {
      // grep 无命中返回码 1，不算错误
      if (e.code === 1 && !e.stderr) return { content: "(无命中)" };
      return { content: e.stderr || `grep 失败: ${e.message}`, isError: true };
    }
  },
};

// ---- 辅助 ----
async function walk(dir: string, out: string[], cap: number): Promise<void> {
  if (out.length >= cap) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out, cap);
    else out.push(full);
    if (out.length >= cap) return;
  }
}

function globToRegExp(glob: string): RegExp {
  // 极简 glob → 正则：** 任意层级，* 单层，? 单字符
  let re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const ALL_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
];

export const TOOL_MAP: Map<string, Tool> = new Map(ALL_TOOLS.map((t) => [t.name, t]));
