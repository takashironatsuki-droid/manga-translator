# Downloads the build tools into D:\manga-app-build and verifies each file's checksum.
$ErrorActionPreference = 'Stop'
$B = 'D:\manga-app-build'
$dl = "$B\dl"
$tools = "$B\tools"

function Fetch($url, $out, $algo, $sum) {
  $have = (Test-Path $out) -and ((Get-FileHash $out -Algorithm $algo).Hash.ToLower() -eq $sum)
  if (-not $have) {
    curl.exe -sS -L --fail --retry 3 -o $out $url
    if ($LASTEXITCODE -ne 0) { throw "download failed: $url" }
  }
  $h = (Get-FileHash $out -Algorithm $algo).Hash.ToLower()
  if ($h -ne $sum) { throw "checksum mismatch for $out : got $h" }
  "OK   $([IO.Path]::GetFileName($out))  $algo verified"
}

function Unpack($zip, $dir) {
  if (Test-Path $dir) { "SKIP $dir already exists"; return }
  New-Item -ItemType Directory -Force $dir | Out-Null
  tar.exe -xf $zip -C $dir --strip-components=1
  if ($LASTEXITCODE -ne 0) { throw "unpack failed: $zip" }
  "OK   unpacked to $dir"
}

Fetch 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21%2B9/OpenJDK17U-jdk_x64_windows_hotspot_17.0.21_9.zip' "$dl\jdk17.zip" 'SHA256' '98518ecf554465057ee5509462631deeee374bc368c12a411d225cd29381f84b'
Fetch 'https://dl.google.com/android/repository/build-tools_r34-windows.zip' "$dl\build-tools.zip" 'SHA1' '62cfde1b6fcc3ad12a4d2ba1b537e752768bfd47'
Fetch 'https://dl.google.com/android/repository/platform-34-ext7_r03.zip' "$dl\platform.zip" 'SHA1' '1f2e9478d6a7601425ceaa553311dc43191f103d'

Unpack "$dl\jdk17.zip" "$tools\jdk"
Unpack "$dl\build-tools.zip" "$tools\build-tools"
Unpack "$dl\platform.zip" "$tools\platform"

foreach ($f in "$tools\jdk\bin\javac.exe", "$tools\jdk\bin\keytool.exe", "$tools\build-tools\aapt2.exe", "$tools\build-tools\zipalign.exe", "$tools\build-tools\lib\d8.jar", "$tools\build-tools\lib\apksigner.jar", "$tools\platform\android.jar") {
  if (Test-Path $f) { "HAVE $f" } else { "MISSING $f" }
}
"ALL DONE"
