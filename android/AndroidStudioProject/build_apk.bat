@echo off
set JAVA_HOME=C:\Users\zch\AppData\Roaming\.minecraft\runtime\java-runtime-delta
set ANDROID_HOME=C:\Users\zch\.local\android-sdk
set GRADLE_USER_HOME=C:\Users\zch\.gradle
cd /d C:\Users\zch\Documents\code\myclass\android\AndroidStudioProject
call C:\Users\zch\.local\gradle-8.9\bin\gradle.bat assembleRelease
copy /Y "app\build\outputs\apk\release\app-release.apk" "..\..\web\public\myclass.apk"
node update-apk-version.js
