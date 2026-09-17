param (
    [Parameter(Mandatory = $true)][string]$Path,
    # Position among the file's icons, the way Windows counts them in "shell32.dll,4". A negative
    # number is a resource ID instead, the way "shell32.dll,-16769" is written.
    [int]$Index = 0,
    # List mode: also print every icon in the file at $ThumbSize, for the picker's grid.
    [switch]$List,
    [int]$ThumbSize = 48
)

# The icons inside a program or an icon library, for a custom icon the user picked.
#
# `extract-icon.ps1` answers a different question — "what does Windows show for this target" — and
# only ever returns the one icon the shell chooses. A file like shell32.dll or imageres.dll holds
# hundreds, and a custom icon is exactly the case where somebody wants the 17th one.
#
# Output is raw, un-normalized PNG: the renderer runs every custom icon (these, pictures, pasted
# images) through one normalization, so a PNG and an .exe icon come out the same optical size.
#
#   count <n>
#   full <data url>            the icon at $Index, at the largest size the file carries
#   thumb <i> <data url>       -List only, one line per icon

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Signature = @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class LibraryIcons {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern uint PrivateExtractIcons(string file, int index, int cx, int cy,
        IntPtr[] icons, uint[] ids, uint count, uint flags);

    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern int GetObject(IntPtr obj, int size, ref BITMAP bm);
    [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines,
        byte[] bits, ref BITMAPINFOHEADER bmi, uint usage);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumResNameProc callback, IntPtr param);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "FindResourceW")]
    static extern IntPtr FindResourceByName(IntPtr module, string name, IntPtr type);
    [DllImport("kernel32.dll")] static extern IntPtr LoadResource(IntPtr module, IntPtr res);
    [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr data);
    [DllImport("kernel32.dll")] static extern uint SizeofResource(IntPtr module, IntPtr res);

    delegate bool EnumResNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);

    [StructLayout(LayoutKind.Sequential)]
    struct ICONINFO { public bool fIcon; public int xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }

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

    const uint LOAD_LIBRARY_AS_DATAFILE = 0x2;
    const uint LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x20;
    static readonly IntPtr RT_GROUP_ICON = (IntPtr)14;

    public static int Count(string file) {
        return (int)PrivateExtractIcons(file, 0, 0, 0, null, null, 0, 0);
    }

    // The largest frame the icon group carries, so the upscale — when there has to be one — is a
    // single high-quality resample on the renderer's side. Asking Windows for 256px from a group
    // that stops at 32px hands back its own stretch, which is visibly blockier.
    //
    // Icon index N is the Nth RT_GROUP_ICON in EnumResourceNames order: that is how the shell has
    // always numbered them. Anything this cannot read (an NE-format .icl, a MUI-redirected system
    // file) answers 256 and lets PrivateExtractIcons do its best.
    public static int NativeSize(string file, int index) {
        IntPtr module = LoadLibraryEx(file, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
        if (module == IntPtr.Zero) return 256;
        try {
            IntPtr res = IntPtr.Zero;
            if (index < 0) {
                res = FindResource(module, (IntPtr)(-index), RT_GROUP_ICON);
            } else {
                var names = new List<object>();
                EnumResourceNames(module, RT_GROUP_ICON, (m, t, name, p) => {
                    long raw = name.ToInt64();
                    if ((raw >> 16) == 0) names.Add((int)raw);
                    else names.Add(Marshal.PtrToStringUni(name));
                    return names.Count <= index;
                }, IntPtr.Zero);
                if (index >= names.Count) return 256;
                object picked = names[index];
                res = picked is int
                    ? FindResource(module, (IntPtr)(int)picked, RT_GROUP_ICON)
                    : FindResourceByName(module, (string)picked, RT_GROUP_ICON);
            }
            if (res == IntPtr.Zero) return 256;
            IntPtr data = LockResource(LoadResource(module, res));
            uint size = SizeofResource(module, res);
            if (data == IntPtr.Zero || size < 6) return 256;
            // GRPICONDIR: reserved, type, count — then 14-byte entries whose first byte is the
            // width, where 0 means 256.
            int count = Marshal.ReadInt16(data, 4);
            int best = 0;
            for (int i = 0; i < count && 6 + (i + 1) * 14 <= size; i++) {
                int width = Marshal.ReadByte(data, 6 + i * 14);
                if (width == 0) width = 256;
                if (width > best) best = width;
            }
            return best > 0 ? best : 256;
        } catch {
            return 256;
        } finally {
            FreeLibrary(module);
        }
    }

    public static string One(string file, int index, int size) {
        IntPtr[] icons = new IntPtr[1];
        uint[] ids = new uint[1];
        uint got = PrivateExtractIcons(file, index, size, size, icons, ids, 1, 0);
        if (got == 0 || got == 0xFFFFFFFF || icons[0] == IntPtr.Zero) return null;
        try { return ToPngDataUrl(icons[0]); }
        finally { DestroyIcon(icons[0]); }
    }

    public static string[] All(string file, int count, int size) {
        IntPtr[] icons = new IntPtr[count];
        uint[] ids = new uint[count];
        uint got = PrivateExtractIcons(file, 0, size, size, icons, ids, (uint)count, 0);
        string[] result = new string[count];
        if (got == 0xFFFFFFFF) return result;
        for (int i = 0; i < count; i++) {
            if (icons[i] == IntPtr.Zero) continue;
            try { result[i] = ToPngDataUrl(icons[i]); }
            catch { result[i] = null; }
            finally { DestroyIcon(icons[i]); }
        }
        return result;
    }

    static string ToPngDataUrl(IntPtr icon) {
        using (Bitmap bitmap = ToBitmap(icon)) {
            if (bitmap == null) return null;
            using (var stream = new MemoryStream()) {
                bitmap.Save(stream, ImageFormat.Png);
                return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
            }
        }
    }

    // HICON to a 32-bit bitmap WITH its transparency. `Icon.ToBitmap` and `Bitmap.FromHicon` both
    // have cases that flatten alpha onto black; reading the DIB bits ourselves does not. Icons with
    // no alpha channel at all (pre-XP artwork) take their transparency from the AND mask instead.
    static Bitmap ToBitmap(IntPtr icon) {
        ICONINFO info;
        if (!GetIconInfo(icon, out info)) return null;
        try {
            if (info.hbmColor == IntPtr.Zero) {
                // Monochrome: the mask holds both halves. Rare enough to leave to GDI+.
                using (Icon managed = Icon.FromHandle(icon)) return managed.ToBitmap();
            }
            BITMAP bm = new BITMAP();
            GetObject(info.hbmColor, Marshal.SizeOf(typeof(BITMAP)), ref bm);
            int width = bm.bmWidth, height = Math.Abs(bm.bmHeight);
            if (width <= 0 || height <= 0) return null;

            byte[] color = ReadBits(info.hbmColor, width, height);
            if (color == null) return null;
            bool hasAlpha = false;
            for (int i = 3; i < color.Length; i += 4) {
                if (color[i] != 0) { hasAlpha = true; break; }
            }
            if (!hasAlpha) {
                byte[] mask = info.hbmMask != IntPtr.Zero ? ReadBits(info.hbmMask, width, height) : null;
                for (int i = 0; i < color.Length; i += 4) {
                    // A set mask bit reads back as white and means "transparent here".
                    bool transparent = mask != null && mask[i] != 0;
                    color[i + 3] = transparent ? (byte)0 : (byte)255;
                }
            }

            Bitmap result = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            BitmapData data = result.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try {
                for (int y = 0; y < height; y++) {
                    Marshal.Copy(color, y * width * 4, data.Scan0 + y * data.Stride, width * 4);
                }
            } finally {
                result.UnlockBits(data);
            }
            return result;
        } finally {
            if (info.hbmColor != IntPtr.Zero) DeleteObject(info.hbmColor);
            if (info.hbmMask != IntPtr.Zero) DeleteObject(info.hbmMask);
        }
    }

    // Top-down BGRA, whatever the bitmap's own format.
    static byte[] ReadBits(IntPtr hbm, int width, int height) {
        var header = new BITMAPINFOHEADER();
        header.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
        header.biWidth = width;
        header.biHeight = -height;
        header.biPlanes = 1;
        header.biBitCount = 32;
        byte[] bits = new byte[width * height * 4];
        IntPtr hdc = GetDC(IntPtr.Zero);
        try {
            return GetDIBits(hdc, hbm, 0, (uint)height, bits, ref header, 0) == 0 ? null : bits;
        } finally {
            ReleaseDC(IntPtr.Zero, hdc);
        }
    }
}
"@
Add-Type -TypeDefinition $Signature -ReferencedAssemblies System.Drawing

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Error "Not a file: $Path"
    exit 2
}

$count = [LibraryIcons]::Count($Path)
Write-Output "count $count"
if ($count -le 0) { exit 0 }

$size = [LibraryIcons]::NativeSize($Path, $Index)
$full = [LibraryIcons]::One($Path, $Index, $size)
if ($full) { Write-Output "full $full" }

if ($List) {
    $thumbs = [LibraryIcons]::All($Path, $count, $ThumbSize)
    for ($i = 0; $i -lt $thumbs.Length; $i++) {
        if ($thumbs[$i]) { Write-Output "thumb $i $($thumbs[$i])" }
    }
}
