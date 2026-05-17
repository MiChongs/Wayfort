"use client"

import * as React from "react"
import { use } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Download, FolderPlus, RefreshCw, Trash2, Upload, FileText, Folder } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { sftpService, type SftpEntry } from "@/lib/api/services"
import { fmtBytes, fullTime } from "@/lib/format"

export default function SFTPPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const nodeId = Number(id)
  const qc = useQueryClient()
  const [path, setPath] = React.useState("/")
  const [mkdirName, setMkdirName] = React.useState("")

  const listing = useQuery({ queryKey: ["sftp", nodeId, path], queryFn: () => sftpService.list(nodeId, path) })

  const mkdir = useMutation({
    mutationFn: (name: string) => sftpService.mkdir(nodeId, joinPath(path, name)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sftp", nodeId, path] }); setMkdirName(""); toast.success("已创建目录") },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })
  const remove = useMutation({
    mutationFn: (p: string) => sftpService.remove(nodeId, p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sftp", nodeId, path] }); toast.success("已删除") },
    onError: (e: unknown) => toast.error("删除失败", { description: (e as Error).message }),
  })
  const upload = useMutation({
    mutationFn: (file: File) => sftpService.upload(nodeId, path, file),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sftp", nodeId, path] }); toast.success("上传成功") },
    onError: (e: unknown) => toast.error("上传失败", { description: (e as Error).message }),
  })

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) upload.mutate(f)
    e.currentTarget.value = ""
  }

  const segments = path.split("/").filter(Boolean)
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">SFTP 文件管理</h1>
        <Button variant="ghost" size="sm" onClick={() => listing.refetch()}>
          <RefreshCw className="w-4 h-4" /> 刷新
        </Button>
      </div>
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Button variant="ghost" size="sm" onClick={() => setPath("/")} disabled={path === "/"}>
          <ArrowLeft className="w-4 h-4" /> 根
        </Button>
        {segments.map((s, i) => {
          const target = "/" + segments.slice(0, i + 1).join("/")
          return (
            <button
              key={target}
              className="hover:underline px-1"
              onClick={() => setPath(target)}
            >
              {s}
              {i < segments.length - 1 && " /"}
            </button>
          )
        })}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={mkdirName}
          onChange={(e) => setMkdirName(e.target.value)}
          placeholder="新文件夹名"
          className="max-w-sm"
        />
        <Button variant="outline" size="sm" disabled={!mkdirName} onClick={() => mkdir.mutate(mkdirName)}>
          <FolderPlus className="w-4 h-4" /> 创建目录
        </Button>
        <label className="inline-flex items-center gap-2 px-3 h-8 rounded-md border text-sm cursor-pointer hover:bg-accent">
          <Upload className="w-4 h-4" />
          上传文件
          <input type="file" onChange={onPick} className="hidden" />
        </label>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">名称</th>
              <th className="text-left px-3 py-2 hidden md:table-cell">大小</th>
              <th className="text-left px-3 py-2 hidden lg:table-cell">权限</th>
              <th className="text-left px-3 py-2 hidden md:table-cell">修改时间</th>
              <th className="text-right px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {(listing.data?.entries || []).map((e: SftpEntry) => (
              <tr key={e.path} className="border-t hover:bg-accent/40">
                <td className="px-3 py-2">
                  <button
                    className="flex items-center gap-2"
                    onClick={() => e.is_dir && setPath(e.path)}
                    disabled={!e.is_dir}
                  >
                    {e.is_dir ? <Folder className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                    <span className={e.is_dir ? "text-primary hover:underline" : ""}>{e.name}</span>
                  </button>
                </td>
                <td className="px-3 py-2 hidden md:table-cell">{e.is_dir ? "" : fmtBytes(e.size)}</td>
                <td className="px-3 py-2 hidden lg:table-cell font-mono text-xs">{e.mode}</td>
                <td className="px-3 py-2 hidden md:table-cell text-xs text-muted-foreground">{fullTime(e.mod_time)}</td>
                <td className="px-3 py-2 text-right space-x-1">
                  {!e.is_dir && (
                    <a
                      className="inline-flex items-center px-2 py-1 rounded hover:bg-accent"
                      href={sftpService.downloadURL(nodeId, e.path)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Download className="w-4 h-4" />
                    </a>
                  )}
                  <button
                    className="inline-flex items-center px-2 py-1 rounded hover:bg-accent text-destructive"
                    onClick={() => confirm("确认删除？") && remove.mutate(e.path)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
            {listing.isLoading && (
              <tr>
                <td colSpan={5} className="text-center text-muted-foreground py-8">加载中…</td>
              </tr>
            )}
            {!listing.isLoading && (listing.data?.entries || []).length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-muted-foreground py-8">空目录</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function joinPath(p: string, name: string): string {
  if (p === "/") return "/" + name
  return p.replace(/\/+$/, "") + "/" + name
}
