@echo off
set JAVA_HOME=C:\Users\zch\AppData\Roaming\.minecraft\runtime\java-runtime-delta
set ANDROID_HOME=C:\Users\zch\Documents\code\myclass\.local\android-sdk
set GRADLE_USER_HOME=C:\Users\zch\.gradle
cd /d C:\Users\zch\Documents\code\myclass\android\AndroidStudioProject
C:\Users\zch\Documents\code\myclass\.local\gradle-8.9\bin\gradle.bat assembleRelease
