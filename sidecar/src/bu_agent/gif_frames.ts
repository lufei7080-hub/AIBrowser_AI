/**
 * Windows GDI+ GIF 全帧拆解（对齐 bat：System.Drawing SelectActiveFrame）
 * 仅 Win32；CREATE_NO_WINDOW / windowsHide 隐藏黑框。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isGifBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x39 || buf[4] === 0x37) &&
    buf[5] === 0x61
  );
}

/**
 * 用 PowerShell + System.Drawing 将 GIF 拆成 frame_000.png …
 * @returns 按序号排序的绝对路径列表
 */
export async function extractGifFramesViaGdi(
  gifAbsPath: string,
  outDirAbs: string,
  opts?: { timeoutMs?: number },
): Promise<string[]> {
  if (process.platform !== "win32") {
    throw new Error("GIF 全帧拆解仅支持 Windows（System.Drawing）");
  }
  if (!existsSync(gifAbsPath)) {
    throw new Error(`GIF 文件不存在: ${gifAbsPath}`);
  }
  mkdirSync(outDirAbs, { recursive: true });

  const timeoutMs = Math.min(60_000, Math.max(5_000, opts?.timeoutMs ?? 15_000));
  // 单引号包裹路径，内部单引号加倍；避免注入
  const gifPs = gifAbsPath.replace(/'/g, "''");
  const outPs = outDirAbs.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    `$gif='${gifPs}'`,
    `$out='${outPs}'`,
    "if(!(Test-Path -LiteralPath $out)){ New-Item -ItemType Directory -Path $out | Out-Null }",
    "Get-ChildItem -LiteralPath $out -Filter 'frame_*.png' -ErrorAction SilentlyContinue | Remove-Item -Force",
    "$img=[System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $gif).Path)",
    "try {",
    "  $dim=New-Object System.Drawing.Imaging.FrameDimension($img.FrameDimensionsList[0])",
    "  $cnt=$img.GetFrameCount($dim)",
    "  for($i=0; $i -lt $cnt; $i++){",
    "    $img.SelectActiveFrame($dim, $i) | Out-Null",
    "    $path=Join-Path $out ('frame_'+$i.ToString('000')+'.png')",
    "    $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)",
    "  }",
    "  Write-Output $cnt",
    "} finally { $img.Dispose() }",
  ].join("; ");

  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`GDI 抽帧失败: ${msg.slice(0, 400)}`);
  }

  const names = readdirSync(outDirAbs)
    .filter((n) => /^frame_\d{3}\.png$/i.test(n))
    .sort();
  if (names.length === 0) {
    throw new Error("GDI 抽帧完成但未生成 frame_*.png");
  }
  return names.map((n) => join(outDirAbs, n));
}

/**
 * 将 PNG 帧放大并转 JPEG，供视觉模型（过小 PNG 易空响应）。
 * @returns jpeg 绝对路径列表（与输入一一对应）
 */
export async function upscaleFramesToJpeg(
  pngPaths: string[],
  outDirAbs: string,
  scale = 4,
  opts?: { timeoutMs?: number },
): Promise<string[]> {
  if (process.platform !== "win32") {
    throw new Error("帧放大仅支持 Windows（System.Drawing）");
  }
  if (pngPaths.length === 0) return [];
  mkdirSync(outDirAbs, { recursive: true });
  const timeoutMs = Math.min(60_000, Math.max(5_000, opts?.timeoutMs ?? 20_000));
  const scaleN = Math.min(8, Math.max(2, Math.floor(scale)));
  const listPath = join(outDirAbs, "_png_list.txt");
  writeFileSync(listPath, pngPaths.join("\n"), "utf8");

  const listPs = listPath.replace(/'/g, "''");
  const outPs = outDirAbs.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    `$list='${listPs}'`,
    `$out='${outPs}'`,
    `$scale=${scaleN}`,
    "$i=0",
    "Get-Content -LiteralPath $list | ForEach-Object {",
    "  $src=$_.Trim()",
    "  if(-not $src){ return }",
    "  $img=[System.Drawing.Image]::FromFile($src)",
    "  try {",
    "    $w=[Math]::Max(8, $img.Width * $scale)",
    "    $h=[Math]::Max(8, $img.Height * $scale)",
    "    $bmp=New-Object System.Drawing.Bitmap $w, $h",
    "    $g=[System.Drawing.Graphics]::FromImage($bmp)",
    "    $g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor",
    "    $g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::Half",
    "    $g.Clear([System.Drawing.Color]::White)",
    "    $g.DrawImage($img, 0, 0, $w, $h)",
    "    $g.Dispose()",
    "    $dest=Join-Path $out ('vision_'+$i.ToString('000')+'.jpg')",
    "    $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    "    $ep=New-Object System.Drawing.Imaging.EncoderParameters(1)",
    "    $ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]92)",
    "    $bmp.Save($dest, $codec, $ep)",
    "    $bmp.Dispose()",
    "    $i++",
    "  } finally { $img.Dispose() }",
    "}",
    "Write-Output $i",
  ].join("; ");

  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`帧放大失败: ${msg.slice(0, 400)}`);
  }

  const names = readdirSync(outDirAbs)
    .filter((n) => /^vision_\d{3}\.jpg$/i.test(n))
    .sort();
  if (names.length === 0) {
    throw new Error("帧放大完成但未生成 vision_*.jpg");
  }
  return names.map((n) => join(outDirAbs, n));
}
