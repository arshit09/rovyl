param (
    [string]$Target
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Every icon is rendered onto this canvas, with its opaque content scaled to
# $ContentRatio of the canvas. Two apps therefore always come out optically the
# same size, regardless of how much padding the original asset baked in.
$CanvasSize   = 256
$ContentRatio = 0.86

# P/Invoke: the Windows shell thumbnail/icon pipeline plus fast pixel scanning.
$Signature = @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class IconExtractor {
    // ── IShellItemImageFactory: the same API Explorer uses. Works for Win32
    // paths AND for packaged apps via shell:AppsFolder\<AUMID>, which is the
    // only reliable route for UWP icons — their assets live under
    // %ProgramFiles%\WindowsApps, whose subfolders are ACL-blocked for normal
    // users, so reading the manifest and opening the PNG cannot work.
    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemImageFactory {
        void GetImage([In, MarshalAs(UnmanagedType.Struct)] SIZE size, [In] int flags, [Out] out IntPtr phbm);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SIZE { public int cx; public int cy; public SIZE(int x, int y) { cx = x; cy = y; } }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc,
        [In] ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAP { public int bmType, bmWidth, bmHeight, bmWidthBytes; public ushort bmPlanes, bmBitsPixel; public IntPtr bmBits; }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER {
        public uint biSize;
        public int biWidth, biHeight;
        public ushort biPlanes, biBitCount;
        public uint biCompression, biSizeImage;
        public int biXPelsPerMeter, biYPelsPerMeter;
        public uint biClrUsed, biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct DIBSECTION {
        public BITMAP dsBm;
        public BITMAPINFOHEADER dsBmih;
        public uint dsBitfields0, dsBitfields1, dsBitfields2;
        public IntPtr dshSection;
        public uint dsOffset;
    }

    [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int c, ref BITMAP pv);
    [DllImport("gdi32.dll", EntryPoint = "GetObject")] static extern int GetObjectDib(IntPtr h, int c, ref DIBSECTION pv);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr ho);

    const int SIIGBF_ICONONLY = 0x4;   // never a document thumbnail, always the icon
    const int SIIGBF_SCALEUP  = 0x100; // upscale small assets to the requested box

    // `allowScaleUp` = let the shell stretch a small icon up to the requested size. We ask
    // WITHOUT it first: the shell returns the largest NATIVE asset the app has, and the
    // upscale (a single bicubic one, here) stays on our side. With SCALEUP there were two
    // resamples in a chain — the shell's and ours — and the result had the washed-out look.
    public static Bitmap GetShellImage(string parsingName, int size) {
        return GetShellImage(parsingName, size, false) ?? GetShellImage(parsingName, size, true);
    }

    public static Bitmap GetShellImage(string parsingName, int size, bool allowScaleUp) {
        Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
        object shellItem;
        SHCreateItemFromParsingName(parsingName, IntPtr.Zero, ref iid, out shellItem);
        IShellItemImageFactory factory = (IShellItemImageFactory)shellItem;

        int flags = SIIGBF_ICONONLY | (allowScaleUp ? SIIGBF_SCALEUP : 0);
        IntPtr hbm = IntPtr.Zero;
        factory.GetImage(new SIZE(size, size), flags, out hbm);
        if (hbm == IntPtr.Zero) return null;

        try {
            DIBSECTION dib = new DIBSECTION();
            GetObjectDib(hbm, Marshal.SizeOf(typeof(DIBSECTION)), ref dib);
            BITMAP bm = dib.dsBm;
            // Image.FromHbitmap drops the alpha channel, which paints icon
            // transparency solid black. Wrap the DIB bits directly instead.
            if (bm.bmBitsPixel != 32 || bm.bmBits == IntPtr.Zero) return Image.FromHbitmap(hbm);

            // DIB sections may store scanlines bottom-up (positive biHeight) or
            // top-down (negative biHeight). Passing every buffer with a positive
            // stride inverted only the bottom-up icons, hence the intermittent
            // upside-down result. Point at the visual top row and preserve the
            // correct stride direction for both layouts.
            int height = Math.Abs(bm.bmHeight);
            int stride = Math.Abs(bm.bmWidthBytes);
            bool bottomUp = dib.dsBmih.biHeight > 0;
            IntPtr topRow = bottomUp
                ? IntPtr.Add(bm.bmBits, (height - 1) * stride)
                : bm.bmBits;
            int orientedStride = bottomUp ? -stride : stride;
            Bitmap premultiplied = new Bitmap(bm.bmWidth, height, orientedStride, PixelFormat.Format32bppPArgb, topRow);
            Bitmap result = new Bitmap(bm.bmWidth, height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(result)) {
                g.Clear(Color.Transparent);
                g.DrawImage(premultiplied, 0, 0);
            }
            premultiplied.Dispose();
            return result;
        } finally {
            DeleteObject(hbm);
        }
    }

    // ── Legacy shell icon list, kept as a fallback for odd Win32 targets ──────
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct SHFILEINFO {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
        public string szTypeName;
    }

    [ComImport]
    [Guid("46EB5926-582E-4017-9FDF-E8998DAA0950")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IImageList {
        [PreserveSig] int GetIcon(int i, int flags, out IntPtr picon);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    [DllImport("shell32.dll", EntryPoint = "#727")]
    public static extern int SHGetImageList(int iImageList, ref Guid riid, out IImageList ppv);

    public const uint SHGFI_SYSICONINDEX = 0x4000;
    public const int SHIL_JUMBO = 0x4;

    public static Icon GetJumboIcon(string path) {
        SHFILEINFO shfi = new SHFILEINFO();
        IntPtr res = SHGetFileInfo(path, 0, ref shfi, (uint)Marshal.SizeOf(shfi), SHGFI_SYSICONINDEX);
        if (res == IntPtr.Zero) return null;

        Guid iid = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");
        IImageList iml;
        int hres = SHGetImageList(SHIL_JUMBO, ref iid, out iml);
        if (hres != 0) return null;

        IntPtr hIcon;
        iml.GetIcon(shfi.iIcon, 1, out hIcon); // 1 = ILD_TRANSPARENT
        if (hIcon == IntPtr.Zero) return null;

        return Icon.FromHandle(hIcon);
    }

    // ── Icon quality: plate halo and opaque border ───────────────────────────
    //
    // Two defects that appear when the source returns the icon ALREADY COMPOSITED on a background:
    //
    //  · HALO  — many near-white partial-alpha pixels: it is the light background cut out by
    //            alpha, and it reads as a burr around the artwork;
    //  · PLATE — a fully opaque outer border: the icon carries the app's background square
    //            instead of the logo with transparency.
    //
    // Returns { partialEdgePixels, ofThoseNearWhite, opaqueBorderPixels, borderTotal }.
    public static int[] Analyze(Bitmap source) {
        Bitmap scan = source;
        bool dispose = false;
        if (scan.PixelFormat != PixelFormat.Format32bppArgb) {
            scan = source.Clone(new Rectangle(0, 0, source.Width, source.Height), PixelFormat.Format32bppArgb);
            dispose = true;
        }
        BitmapData data = scan.LockBits(new Rectangle(0, 0, scan.Width, scan.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try {
            int partial = 0, whitePartial = 0, borderOpaque = 0, borderTotal = 0;
            int inset = Math.Max(1, scan.Width / 24);
            byte[] row = new byte[data.Stride];
            for (int y = 0; y < scan.Height; y++) {
                Marshal.Copy(data.Scan0 + y * data.Stride, row, 0, data.Stride);
                bool borderRow = y < inset || y >= scan.Height - inset;
                for (int x = 0; x < scan.Width; x++) {
                    byte b = row[x * 4], g = row[x * 4 + 1], r = row[x * 4 + 2], a = row[x * 4 + 3];
                    if (a > 0 && a < 250) {
                        partial++;
                        if (r > 235 && g > 235 && b > 235) whitePartial++;
                    }
                    if (borderRow || x < inset || x >= scan.Width - inset) {
                        borderTotal++;
                        if (a > 250) borderOpaque++;
                    }
                }
            }
            return new int[] { partial, whitePartial, borderOpaque, borderTotal };
        } finally {
            scan.UnlockBits(data);
            if (dispose) scan.Dispose();
        }
    }

    // ── Bounding box of the non-transparent pixels ───────────────────────────
    // Scanned through LockBits: the equivalent GetPixel loop in PowerShell is
    // ~65k interop calls per icon and dominates the extraction cost.
    // Returns {minX, minY, maxX, maxY}, or null when fully transparent.
    public static int[] AlphaBounds(Bitmap source, int alphaThreshold) {
        Bitmap scan = source;
        bool disposeScan = false;
        if (scan.PixelFormat != PixelFormat.Format32bppArgb) {
            scan = source.Clone(new Rectangle(0, 0, source.Width, source.Height), PixelFormat.Format32bppArgb);
            disposeScan = true;
        }

        BitmapData data = scan.LockBits(new Rectangle(0, 0, scan.Width, scan.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try {
            int minX = scan.Width, minY = scan.Height, maxX = -1, maxY = -1;
            byte[] row = new byte[data.Stride];
            for (int y = 0; y < scan.Height; y++) {
                Marshal.Copy(data.Scan0 + y * data.Stride, row, 0, data.Stride);
                for (int x = 0; x < scan.Width; x++) {
                    if (row[x * 4 + 3] <= alphaThreshold) continue; // BGRA: alpha is byte 3
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
            if (maxX < 0) return null;
            return new int[] { minX, minY, maxX, maxY };
        } finally {
            scan.UnlockBits(data);
            if (disposeScan) scan.Dispose();
        }
    }
}
"@
Add-Type -TypeDefinition $Signature -ReferencedAssemblies System.Drawing

# Crops to the visible content and rescales it to a fixed fraction of the
# canvas, so every icon lands at the same optical size no matter how much
# transparent margin its source asset carried.
function ConvertTo-NormalizedIconBitmap {
    param ([System.Drawing.Bitmap]$Source)

    $bounds = [IconExtractor]::AlphaBounds($Source, 12)
    if ($bounds) {
        $minX = $bounds[0]; $minY = $bounds[1]; $maxX = $bounds[2]; $maxY = $bounds[3]
    } else {
        $minX = 0; $minY = 0; $maxX = $Source.Width - 1; $maxY = $Source.Height - 1
    }

    $contentW = $maxX - $minX + 1
    $contentH = $maxY - $minY + 1
    if ($contentW -le 0 -or $contentH -le 0) { return $null }

    $target = $CanvasSize * $ContentRatio
    $scale  = $target / [Math]::Max($contentW, $contentH)
    $drawW  = [Math]::Max(1, [int][Math]::Round($contentW * $scale))
    $drawH  = [Math]::Max(1, [int][Math]::Round($contentH * $scale))
    $destX  = [int][Math]::Round(($CanvasSize - $drawW) / 2)
    $destY  = [int][Math]::Round(($CanvasSize - $drawH) / 2)

    # Resize in PREMULTIPLIED ALPHA.
    #
    # In `Format32bppArgb` (straight alpha) GDI+ interpolates R, G, B and A separately. At the
    # edges of an icon there are fully transparent pixels that, invisible as they are, still
    # hold a colour — and in many assets that colour is white. On interpolation that white
    # enters the average of its neighbours and shows as a fringe around the artwork: exactly
    # the "cut out of the background" with a white burr. Premultiplied, the colour of a
    # transparent pixel is worth zero and contaminates nobody.
    $canvas = New-Object System.Drawing.Bitmap($CanvasSize, $CanvasSize, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    $g = [System.Drawing.Graphics]::FromImage($canvas)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    # Wrap-mode clamp stops the bicubic kernel from sampling transparent pixels
    # outside the crop, which otherwise leaves a faint halo on the edges.
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $attrs.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)

    # The source has to be premultiplied too, otherwise the conversion happens after the
    # interpolation and the problem stays.
    $srcRect = New-Object System.Drawing.Rectangle($minX, $minY, $contentW, $contentH)
    $sourceP = $Source.Clone($srcRect, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    $dstRect = New-Object System.Drawing.Rectangle($destX, $destY, $drawW, $drawH)
    $g.DrawImage($sourceP, $dstRect, 0, 0, $contentW, $contentH, [System.Drawing.GraphicsUnit]::Pixel, $attrs)

    $sourceP.Dispose()
    $attrs.Dispose()
    $g.Dispose()

    # Back to straight alpha for the PNG: `Clone` does the un-multiply correctly.
    $full = New-Object System.Drawing.Rectangle(0, 0, $CanvasSize, $CanvasSize)
    $out = $canvas.Clone($full, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $canvas.Dispose()
    return $out
}

function Out-Base64Png {
    param ([System.Drawing.Bitmap]$Bitmap)
    if (-not $Bitmap) { return $null }
    $normalized = ConvertTo-NormalizedIconBitmap -Source $Bitmap
    if (-not $normalized) { return $null }
    $stream = New-Object System.IO.MemoryStream
    $normalized.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
    $stream.Close(); $stream.Dispose(); $normalized.Dispose()
    return "data:image/png;base64," + [Convert]::ToBase64String($bytes)
}

# Shell icon for any parsing name: a file path, or shell:AppsFolder\<AUMID>.
function Get-ShellIcon {
    param ([string]$ParsingName)
    if (-not $ParsingName) { return $null }
    try {
        $bitmap = [IconExtractor]::GetShellImage($ParsingName, $CanvasSize)
        if (-not $bitmap) { return $null }
        $result = Out-Base64Png -Bitmap $bitmap
        $bitmap.Dispose()
        return $result
    } catch {
        Write-Error "Shell icon failed for $($ParsingName): $($_.Exception.Message)"
        return $null
    }
}


# Best asset inside the MSIX/UWP package — from the MANIFEST, not from guesswork.
#
# The previous version looked for files with "Logo" in the name and preferred the ones that
# had transparency. Two assumptions, both wrong:
#
#  · the file name is not normalized — WhatsApp declares `Assets\AppList.png` and
#    `Assets\MedTile.png`, so the search for "*Logo*" never even touched it; it picked up a
#    stray blue `logo.scale-200.png` that is not the app's icon. That was the one you saw;
#  · transparency does not mean "better". WhatsApp's real icon IS an opaque green square,
#    and the transparent variant that exists is 24px.
#
# The manifest says exactly which visual assets the app has. Read from there, expand the
# variants (`.targetsize-256`, `.scale-400`, …) and keep the highest resolution one.
function Get-PackageLogoAsset {
    param ([string]$InstallPath)
    if (-not $InstallPath -or -not (Test-Path $InstallPath)) { return $null }

    $manifestPath = Join-Path $InstallPath "AppxManifest.xml"
    if (-not (Test-Path $manifestPath)) { return $null }

    try { [xml]$xml = Get-Content $manifestPath -ErrorAction Stop } catch { return $null }

    # Order of FAMILIES, not "the biggest of them all". That was Spotify's lesson: its biggest
    # asset is `Square150x150Logo.scale-400` (600px) — the Start Menu TILE, a green square with
    # the wordmark. What Windows shows as the app icon is `Square44x44Logo`, whose
    # `targetsize-256_altform-unplated` variant is the circle everyone recognizes.
    #
    # So the icon family first; the tile only comes in if that one yields nothing usable.
    $families = @()
    foreach ($appEntry in @($xml.Package.Applications.Application)) {
        if (-not $appEntry.VisualElements) { continue }
        $ve = $appEntry.VisualElements
        $families += ,@($ve.Square44x44Logo)
        $families += ,@($ve.Square150x150Logo)
        $families += ,@($ve.Square310x310Logo, $ve.Logo)
    }
    if (-not $families) { return $null }

    $best = $null
    foreach ($family in $families) {
        $familyBest = $null
        foreach ($relative in ($family | Where-Object { $_ })) {
            $full = Join-Path $InstallPath $relative
            $dir  = Split-Path $full
            if (-not (Test-Path $dir)) { continue }
            $stem = [System.IO.Path]::GetFileNameWithoutExtension($full)
            $ext  = [System.IO.Path]::GetExtension($full)

            $variants = @(Get-ChildItem -Path $dir -Filter "$stem*$ext" -ErrorAction SilentlyContinue)
            if (Test-Path $full) { $variants = @(Get-Item $full) + $variants }

            foreach ($variant in $variants) {
                # `contrast-white` / `contrast-black` are the monochrome versions for Windows'
                # high-contrast themes — never the icon to show.
                if ($variant.Name -match 'contrast-(white|black)') { continue }
                try {
                    $bmp = [System.Drawing.Bitmap]::FromFile($variant.FullName)
                    $area = $bmp.Width * $bmp.Height
                    $bmp.Dispose()
                    # `altform-unplated` is the artwork without the background plate. Worth a
                    # bonus, not an automatic win: WhatsApp's only exists at 24px and loses to 256.
                    $score = if ($variant.Name -match 'unplated') { $area * 1.25 } else { $area }
                    if (-not $familyBest -or $score -gt $familyBest.Score) {
                        $familyBest = [PSCustomObject]@{ Path = $variant.FullName; Score = $score; Area = $area }
                    }
                } catch { }
            }
        }
        # Family resolved at a usable size: stop here, without dropping down to the tile.
        if ($familyBest -and $familyBest.Area -ge 4096) { $best = $familyBest; break }
        if ($familyBest -and (-not $best -or $familyBest.Area -gt $best.Area)) { $best = $familyBest }
    }

    if ($best) { return $best.Path }
    return $null
}

function Get-PackagedAppIcon {
    param ([string]$AppId)
    if (-not $AppId -or $AppId -notmatch '!') { return $null }
    $family = ($AppId -split '!')[0]
    $pkg = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.PackageFamilyName -eq $family } | Select-Object -First 1
    if (-not $pkg -or -not $pkg.InstallLocation) { return $null }
    $asset = Get-PackageLogoAsset -InstallPath $pkg.InstallLocation
    if (-not $asset) { return $null }
    try {
        $bitmap = [System.Drawing.Bitmap]::FromFile($asset)
        $result = Out-Base64Png -Bitmap $bitmap
        $bitmap.Dispose()
        return $result
    } catch {
        return $null
    }
}


# ── Choice by quality, for ANY app ────────────────────────────────────────────
#
# Extraction is no longer "the first one to answer wins". Every source (package asset, shell,
# jumbo list, Start Menu shortcut) produces a candidate; the candidate is measured and only
# accepted if it is clean. If none is, the least bad one stays — always better than blindly
# returning the first. This is what makes the fix global instead of specific to Store apps.
$Script:HaloLimit  = 0.25   # fraction of near-white edges tolerated
$Script:PlateLimit = 0.60   # fraction of the outer border allowed to be opaque

function Measure-IconCandidate {
    param ([System.Drawing.Bitmap]$Bitmap)
    if (-not $Bitmap) { return $null }
    try {
        $m = [IconExtractor]::Analyze($Bitmap)
        $halo  = if ($m[0] -gt 0) { $m[1] / [double]$m[0] } else { 0 }
        $plate = if ($m[3] -gt 0) { $m[2] / [double]$m[3] } else { 0 }
        return [PSCustomObject]@{
            Halo  = $halo
            Plate = $plate
            Area  = $Bitmap.Width * $Bitmap.Height
            # Only the halo fails a candidate. "Opaque border" is not a defect: many legitimate
            # icons are full squares (WhatsApp, Spotify). It is measured only to break ties.
            Clean = ($halo -lt $Script:HaloLimit)
        }
    } catch {
        return $null
    }
}

# Takes blocks that return a Bitmap. Evaluates them in order and returns the best one's data URL.
function Select-BestIcon {
    param ([System.Collections.IEnumerable]$Producers)

    $best = $null
    $bestScore = $null
    foreach ($producer in $Producers) {
        $bitmap = $null
        try { $bitmap = & $producer } catch { $bitmap = $null }
        if (-not $bitmap) { continue }

        $score = Measure-IconCandidate -Bitmap $bitmap
        if (-not $score) { $bitmap.Dispose(); continue }

        if ($score.Clean) {
            # Clean: accept it now — no point paying for the sources that follow.
            $result = Out-Base64Png -Bitmap $bitmap
            $bitmap.Dispose()
            if ($best) { $best.Dispose() }
            if ($result) { return $result }
            continue
        }

        # Dirty: keep it as a net if it beats the previous one (less halo, then larger).
        $better = (-not $best) -or ($score.Halo -lt $bestScore.Halo) -or
                  ($score.Halo -eq $bestScore.Halo -and $score.Area -gt $bestScore.Area)
        if ($better) {
            if ($best) { $best.Dispose() }
            $best = $bitmap
            $bestScore = $score
        } else {
            $bitmap.Dispose()
        }
    }

    if ($best) {
        $result = Out-Base64Png -Bitmap $best
        $best.Dispose()
        return $result
    }
    return $null
}

# ── Candidate producers (they return a Bitmap, not a data URL) ────────────────

function New-PackageAssetBitmap {
    param ([string]$AppId)
    if (-not $AppId -or $AppId -notmatch '!') { return $null }
    $family = ($AppId -split '!')[0]
    $pkg = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.PackageFamilyName -eq $family } | Select-Object -First 1
    if (-not $pkg -or -not $pkg.InstallLocation) { return $null }
    $asset = Get-PackageLogoAsset -InstallPath $pkg.InstallLocation
    if (-not $asset) { return $null }
    try { return [System.Drawing.Bitmap]::FromFile($asset) } catch { return $null }
}

function New-ShellBitmap {
    param ([string]$ParsingName)
    if (-not $ParsingName) { return $null }
    try { return [IconExtractor]::GetShellImage($ParsingName, $CanvasSize) } catch { return $null }
}

function New-JumboBitmap {
    param ([string]$Path)
    if (-not $Path -or -not (Test-Path $Path)) { return $null }
    try {
        $icon = [IconExtractor]::GetJumboIcon($Path)
        if (-not $icon) { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Path) }
        if (-not $icon) { return $null }
        $bmp = $icon.ToBitmap()
        $icon.Dispose()
        return $bmp
    } catch { return $null }
}

function Get-AppsFolderIcon {
    param ([string]$AppId)
    if (-not $AppId) { return $null }
    return Get-ShellIcon -ParsingName "shell:AppsFolder\$AppId"
}

function Get-Base64Icon {
    param ([string]$Path)
    if (-not (Test-Path $Path)) {
        Write-Error "Path not found: $($Path)"
        return $null
    }

    try {
        if ($Path -match '\.(png|jpg|jpeg|bmp|ico)$') {
            $bitmap = [System.Drawing.Bitmap]::FromFile($Path)
            $result = Out-Base64Png -Bitmap $bitmap
            $bitmap.Dispose()
            if ($result) { return $result }
        }

        # Shell first: it returns the app's real 256px icon, including the
        # per-app overrides Explorer shows. Jumbo is the compatibility net.
        $result = Get-ShellIcon -ParsingName $Path
        if ($result) { return $result }

        $icon = [IconExtractor]::GetJumboIcon($Path)
        if (-not $icon) {
            Write-Error "Jumbo icon extraction failed for $($Path), trying ExtractAssociatedIcon"
            $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Path)
        }
        if ($icon) {
            $bitmap = $icon.ToBitmap()
            $icon.Dispose()
            $result = Out-Base64Png -Bitmap $bitmap
            $bitmap.Dispose()
            if ($result) { return $result }
        }
        Write-Error "Failed to create bitmap from $($Path)"
    } catch {
        Write-Error "Exception in Get-Base64Icon for $($Path): $_"
    }
    return $null
}

# Manifest crawl, kept only as a last resort: it reads assets under
# %ProgramFiles%\WindowsApps, which is unreadable for most packages, so it
# fails for exactly the apps (Copilot, Xbox, Photos…) the shell handles fine.
function Get-UWPIconFromPackage {
    param ([string]$PackageFamilyName)
    if (-not $PackageFamilyName) {
        Write-Error "UWP: empty PackageFamilyName"
        return $null
    }

    $pkg = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.PackageFamilyName -eq $PackageFamilyName }
    if (-not $pkg) {
        $prefix = ($PackageFamilyName -split '_')[0]
        if ($prefix) {
            $likePat = $prefix + '_*'
            $pkg = Get-AppxPackage -ErrorAction SilentlyContinue |
                Where-Object { $_.PackageFamilyName -like $likePat } |
                Select-Object -First 1
        }
    }
    if (-not $pkg -or -not $pkg.InstallLocation) {
        Write-Error "UWP Package not found: $PackageFamilyName"
        return $null
    }

    $installPath = $pkg.InstallLocation
    $manifestPath = Join-Path $installPath "AppxManifest.xml"
    if (-not (Test-Path $manifestPath)) {
        Write-Error "UWP Manifest not found at $manifestPath"
        return $null
    }

    [xml]$xml = Get-Content $manifestPath
    $logoNodes = @()
    foreach ($appEntry in @($xml.Package.Applications.Application)) {
        if (-not $appEntry.VisualElements) { continue }
        $ve = $appEntry.VisualElements
        # Square logos only — a wide tile would normalize to a stretched icon.
        $logoNodes += @($ve.Square310x310Logo, $ve.Square150x150Logo, $ve.Square44x44Logo, $ve.Logo)
    }
    $logoNodes = $logoNodes | Where-Object { $_ }

    foreach ($logo in $logoNodes) {
        $logoPath = Join-Path $installPath $logo
        if (Test-Path $logoPath) {
            $result = Get-Base64Icon -Path $logoPath
            if ($result) { return $result }
        }
        $dir  = Split-Path $logoPath
        $name = Split-Path $logoPath -LeafBase
        $ext  = Split-Path $logoPath -Extension
        $name = $name -replace '\.scale-\d+$', '' -replace '\.targetsize-\d+$', '' -replace '\.contrast-\w+$', ''
        if (-not (Test-Path $dir)) { continue }

        # Unplated variants first: they are the transparent icon, while the
        # plated ones carry the app's accent-colour background square.
        $patterns = @(
            "$name.targetsize-256_altform-unplated$ext", "$name.targetsize-256$ext",
            "$name.scale-400$ext", "$name.targetsize-96_altform-unplated$ext",
            "$name.targetsize-96$ext", "$name.scale-200$ext",
            "$name.targetsize-48$ext", "$name.scale-150$ext", "$name.scale-100$ext"
        )
        foreach ($pattern in $patterns) {
            $fullPath = Join-Path $dir $pattern
            if (Test-Path $fullPath) {
                $result = Get-Base64Icon -Path $fullPath
                if ($result) { return $result }
            }
        }
        $candidate = Get-ChildItem -Path $dir -Filter "$name*$ext" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '(targetsize-\d+|scale-\d+)' } |
            Sort-Object Name -Descending | Select-Object -First 1
        if ($candidate) {
            $result = Get-Base64Icon -Path $candidate.FullName
            if ($result) { return $result }
        }
    }

    Write-Error "UWP icon extraction failed for $PackageFamilyName"
    return $null
}

function Get-ShortcutIcon {
    param ([string]$AppName)
    if (-not $AppName) { return $null }
    $smPaths = @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs")
    foreach ($p in $smPaths) {
        if (-not (Test-Path $p)) { continue }
        $lnk = Get-ChildItem -Path $p -Filter "$AppName.lnk" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $lnk) { continue }
        try {
            $sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk.FullName)
            if ($sh.IconLocation -and $sh.IconLocation -ne ",0") {
                $iconPath = $sh.IconLocation.Split(',')[0]
                if (Test-Path $iconPath) {
                    $res = Get-Base64Icon -Path $iconPath
                    if ($res) { return $res }
                }
            }
            if ($sh.TargetPath -and (Test-Path $sh.TargetPath)) {
                $res = Get-Base64Icon -Path $sh.TargetPath
                if ($res) { return $res }
            }
            $res = Get-Base64Icon -Path $lnk.FullName
            if ($res) { return $res }
        } catch {}
    }
    return $null
}

# ── Main logic ────────────────────────────────────────────────────────────────

# 1. Packaged app (AUMID): package asset and shell image compete, the cleanest one wins.
if ($Target -match '!') {
    $res = Select-BestIcon -Producers @(
        { New-PackageAssetBitmap -AppId $Target },
        { New-ShellBitmap -ParsingName "shell:AppsFolder\$Target" }
    )
    if ($res) { Write-Output $res; exit }
}

# 2. File or folder on disk: shell and jumbo list compete on the same criterion. An icon
#    delivered with a plate by either of them is rejected in favour of the other.
if ($Target -and (Test-Path $Target)) {
    if ($Target -match '\.(png|jpg|jpeg|bmp|ico)$') {
        $res = Select-BestIcon -Producers @({ [System.Drawing.Bitmap]::FromFile($Target) })
        if ($res) { Write-Output $res; exit }
    }
    $res = Select-BestIcon -Producers @(
        { New-ShellBitmap -ParsingName $Target },
        { New-JumboBitmap -Path $Target }
    )
    if ($res) { Write-Output $res; exit }
}

# 3. Well-known aliases that arrive without a path.
if ($Target -ieq "MSEdge" -or $Target -imatch "MicrosoftEdge" -or $Target -ieq "msedge") {
    $edgePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"
    if (Test-Path $edgePath) { $res = Get-Base64Icon -Path $edgePath; if ($res) { Write-Output $res; exit } }
}
if ($Target -ieq "Explorer" -or $Target -ieq "File Explorer") {
    $expPath = Join-Path $env:SystemRoot "explorer.exe"
    if (Test-Path $expPath) { $res = Get-Base64Icon -Path $expPath; if ($res) { Write-Output $res; exit } }
}

# 4. Resolve a display name through the Start menu index.
# Start Menu matching: STRICT and in order of confidence.
#
# The previous code accepted `$_.AppID -like "*$Target*"` and, as a last resort, `$_.Name -match
# $Target` — a REGULAR EXPRESSION match over text that comes from the config. Two consequences:
# "WhatsApp" also caught "WhatsApp Beta" and kept whichever one showed up first, and any target
# with dots or parentheses (an AUMID, for instance) became a pattern and could match any app at
# all. This is where the swapped icons came from.
#
# Now: exact equality first; then prefix, always picking the SHORTEST name — between "WhatsApp"
# and "WhatsApp Beta", the request "WhatsApp" gets the first. None of this found, we give up:
# a generic icon is better than the wrong icon.
$startAppsAll = @(Get-StartApps -ErrorAction SilentlyContinue)
$targetLower = $Target.ToLowerInvariant()

$startApp = $startAppsAll | Where-Object { $_.AppID -and $_.AppID.ToLowerInvariant() -eq $targetLower } | Select-Object -First 1
if (-not $startApp) {
    $startApp = $startAppsAll | Where-Object { $_.Name -and $_.Name.ToLowerInvariant() -eq $targetLower } | Select-Object -First 1
}
if (-not $startApp -and $targetLower.Length -ge 3) {
    # Minimum of 3 characters: with "X" the prefix caught "XBOX".
    $startApp = $startAppsAll |
        Where-Object { $_.Name -and $_.Name.ToLowerInvariant().StartsWith($targetLower) } |
        Sort-Object { $_.Name.Length } | Select-Object -First 1
}
if (-not $startApp -and $targetLower.Length -ge 4) {
    # Last resort: the target as an AppID segment (before the "!" or the "_"), never as a regex.
    $startApp = $startAppsAll |
        Where-Object {
            $_.AppID -and (($_.AppID.ToLowerInvariant() -split '[!_.]') -contains $targetLower)
        } |
        Select-Object -First 1
}
if ($startApp) {
    $appId = $startApp.AppID
    $res = Select-BestIcon -Producers @(
        { New-PackageAssetBitmap -AppId $appId },
        { New-ShellBitmap -ParsingName "shell:AppsFolder\$appId" },
        { New-JumboBitmap -Path $appId }
    )
    if ($res) { Write-Output $res; exit }
    if (Test-Path $appId) {
        $res = Get-Base64Icon -Path $appId
        if ($res) { Write-Output $res; exit }
    }
    if ($appId -match '!') {
        $res = Get-UWPIconFromPackage -PackageFamilyName ($appId -split '!')[0]
        if ($res) { Write-Output $res; exit }
    }
    $res = Get-ShortcutIcon -AppName $startApp.Name
    if ($res) { Write-Output $res; exit }
}

# 5. Manifest crawl for an AUMID the shell refused.
if ($Target -match '!') {
    $res = Get-UWPIconFromPackage -PackageFamilyName ($Target -split '!')[0]
    if ($res) { Write-Output $res; exit }
}

$knownApps = @{"Calculator" = "Microsoft.WindowsCalculator_8wekyb3d8bbwe"; "Calculadora" = "Microsoft.WindowsCalculator_8wekyb3d8bbwe"; "Notepad" = "Microsoft.WindowsNotepad_8wekyb3d8bbwe"; "Edge" = "Microsoft.MicrosoftEdge_8wekyb3d8bbwe"}
if ($knownApps.ContainsKey($Target)) {
    $res = Get-AppsFolderIcon -AppId ($knownApps[$Target] + "!App")
    if ($res) { Write-Output $res; exit }
    $res = Get-UWPIconFromPackage -PackageFamilyName $knownApps[$Target]
    if ($res) { Write-Output $res; exit }
}
