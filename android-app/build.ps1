# Builds the Android app into D:\manga-app-build\manga-translator-<version>.apk
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File D:\manga-app-build\project\build.ps1
$ErrorActionPreference = 'Stop'
$B = 'D:\manga-app-build'
$P = "$B\project"
$JDK = "$B\tools\jdk\bin"
$BT = "$B\tools\build-tools"
$AJAR = "$B\tools\platform\android.jar"
# android.jar has no LambdaMetafactory; this stub jar from build-tools lets javac compile lambdas
$BOOT = "$AJAR;$BT\core-lambda-stubs.jar"
$EN = '-Duser.language=en'   # English tool messages (the console mangles localized ones)
$VersionCode = 4
$VersionName = '1.3.0'
$OUT = "$P\out\" + (Get-Date -Format 'yyyyMMdd-HHmmss')

function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" } }

New-Item -ItemType Directory -Force "$OUT\classes", "$OUT\gen", "$OUT\dex" | Out-Null

"[1/7] resources"
& "$BT\aapt2.exe" compile --dir "$P\res" -o "$OUT\res.zip"; Check 'aapt2 compile'
& "$BT\aapt2.exe" link -o "$OUT\base.apk" -I $AJAR --manifest "$P\AndroidManifest.xml" -A "$P\assets" --java "$OUT\gen" -0 arsc --min-sdk-version 24 --target-sdk-version 34 --version-code $VersionCode --version-name $VersionName "$OUT\res.zip"; Check 'aapt2 link'

"[2/7] compile java"
$src = @(Get-ChildItem -Recurse -Filter *.java -Path "$P\src", "$OUT\gen" | ForEach-Object { $_.FullName })
if (-not (Test-Path "$BT\core-lambda-stubs.jar")) { throw 'core-lambda-stubs.jar is missing from build-tools' }
& "$JDK\javac.exe" "-J$EN" -encoding UTF-8 -source 8 -target 8 -bootclasspath $BOOT -Xlint:-options -nowarn -d "$OUT\classes" $src; Check 'javac'
& "$JDK\jar.exe" cf "$OUT\classes.jar" -C "$OUT\classes" .; Check 'jar'

"[3/7] convert to dex"
& "$JDK\java.exe" $EN -cp "$BT\lib\d8.jar" com.android.tools.r8.D8 --release --min-api 24 --lib $AJAR --output "$OUT\dex" "$OUT\classes.jar"; Check 'd8'

"[4/7] package"
Copy-Item "$OUT\base.apk" "$OUT\unsigned.apk"
& "$JDK\jar.exe" uf "$OUT\unsigned.apk" -C "$OUT\dex" classes.dex; Check 'add classes.dex'
& "$BT\zipalign.exe" -f -p 4 "$OUT\unsigned.apk" "$OUT\aligned.apk"; Check 'zipalign'

"[5/7] signing key"
$KS = "$B\keystore"
if (-not (Test-Path "$KS\manga.keystore")) {
  New-Item -ItemType Directory -Force $KS | Out-Null
  $chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  $bytes = New-Object byte[] 28
  $rng.GetBytes($bytes)
  $pw = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
  [IO.File]::WriteAllText("$KS\password.txt", $pw)
  & "$JDK\keytool.exe" "-J$EN" -genkeypair -keystore "$KS\manga.keystore" -storetype PKCS12 -alias manga -keyalg RSA -keysize 2048 -validity 10950 -dname "CN=Manga Translator personal build" -storepass:file "$KS\password.txt"; Check 'keytool'
  "created a new signing key in $KS (keep this folder: updates must be signed with the same key)"
} else { "using the existing signing key" }

"[6/7] sign"
$final = "$B\manga-translator-$VersionName.apk"
& "$JDK\java.exe" $EN -jar "$BT\lib\apksigner.jar" sign --ks "$KS\manga.keystore" --ks-key-alias manga --ks-pass "file:$KS\password.txt" --min-sdk-version 24 --out $final "$OUT\aligned.apk"; Check 'apksigner sign'

"[7/7] verify"
& "$JDK\java.exe" $EN -jar "$BT\lib\apksigner.jar" verify --verbose --min-sdk-version 24 $final; Check 'apksigner verify'
& "$BT\zipalign.exe" -c 4 $final; Check 'zipalign check'
& "$BT\aapt2.exe" dump badging $final | Select-String -Pattern '^(package|sdkVersion|targetSdkVersion|application-label:|uses-permission|launchable-activity)' | ForEach-Object { $_.Line }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($final)
$zip.Entries | ForEach-Object { '{0,-46} {1,9} {2,9}' -f $_.FullName, $_.Length, $_.CompressedLength }
$zip.Dispose()
"BUILD OK -> $final  ({0:N0} bytes)" -f (Get-Item $final).Length
