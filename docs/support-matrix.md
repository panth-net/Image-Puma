# Image Puma Format Support Matrix

Image Puma uses Sharp/libvips first. On macOS only, it can fall back to `/usr/bin/sips` for selected ImageIO-supported inputs when Sharp cannot decode them.

| Format family | macOS | Windows | Linux | Notes |
| --- | --- | --- | --- | --- |
| JPEG / JPG | Supported | Supported | Supported | Export target: JPEG. |
| PNG | Supported | Supported | Supported | Export target: PNG. |
| WebP | Supported | Supported | Supported | Export target: WebP. |
| AVIF | Supported by bundled Sharp | Supported by bundled Sharp | Supported by bundled Sharp | Export target: AVIF. |
| TIFF / TIF | Supported | Supported | Supported | Export target: TIFF. |
| ICO | Supported | Supported | Supported | Export target: multi-resolution Windows ICO with 16, 20, 24, 32, 40, 48, 64, 128, and 256px representations. |
| ICNS | Supported | Supported | Supported | Export target: multi-resolution macOS ICNS with 16px through 1024px representations. |
| HEIC / HEIF / HIF | Sharp first, then macOS ImageIO fallback through `sips` | Sharp first, then the bundled libheif decoder | Sharp first, then the bundled libheif decoder | Prebuilt Sharp on Windows and Linux can read the HEIF container but cannot decode iPhone HEVC. Image Puma then decodes those files with bundled libheif. If that also fails, the file is skipped or the run fails with a decode error. `keep-original` exports HEIC-like inputs as JPEG because Image Puma does not write HEIC. |
| BMP / ICO / ICNS / JPEG 2000 / PSD / TGA / JXL / SGI inputs | Sharp first, plus macOS ImageIO fallback for known native extensions | Sharp only | Sharp only | Input availability depends on the bundled Sharp/libvips build and OS fallback support. |
| GIF / animated inputs | Sharp-dependent | Sharp-dependent | Sharp-dependent | Image Puma treats supported inputs as image sources for static export workflows. |

Quick Favicon exports a multi-resolution `favicon.ico`, 16px and 32px favicon PNGs, a 180px Apple touch icon, a multi-resolution Windows `app-icon.ico`, a macOS `app-icon.icns`, and a 1024px Linux/general `app-icon.png` on all three desktop platforms and through MCP.

MCP v1 excludes background removal on every platform. The desktop background-removal workflow remains separate from the MCP server.
