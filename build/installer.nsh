# An update removes the old app before copying the new one, so finish an interrupted one at next sign-in.
!define UPDATE_RUN_ONCE_KEY "Software\Microsoft\Windows\CurrentVersion\RunOnce"
!define UPDATE_RUN_ONCE_NAME "${PRODUCT_NAME} update"

!macro winkUpdateTrace PHASE FIRST LOOPS
!ifndef BUILD_UNINSTALLER
  # The generated flag predicates use $R9 internally.
  Push $R9
  Push $R4
  StrCpy $R4 0
  ${if} ${Errors}
    StrCpy $R4 1
  ${endIf}
  ${if} ${isUpdated}
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8
    Push $9
    ReadEnvStr $0 "APPDATA"
    ${if} $0 != ""
    ${andIf} ${FileExists} "$0\orbit-desktop\logs\*.*"
      # UTC FILETIME uses scalar 100 ns ticks since 1601.
      System::Call 'kernel32::GetSystemTimeAsFileTime(*l .r2)'
      System::Call 'kernel32::GetCurrentProcessId() i .r3'
      System::Call 'shell32::IsUserAnAdmin() i .r7'
      StrCpy $5 0
      ${if} ${Silent}
        StrCpy $5 1
      ${endIf}
      StrCpy $6 0
      ${if} ${isForceRun}
        StrCpy $6 1
      ${endIf}
      StrCpy $4 "utcFileTime=$2 phase=${PHASE} version=${VERSION} pid=$3 silent=$5 forcerun=$6 admin=$7"
      !if "${PHASE}" == "init"
        ClearErrors
        ReadRegStr $9 HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_NAME}"
        StrCpy $8 1
        ${if} ${Errors}
          StrCpy $8 0
        ${endIf}
        StrCpy $4 "$4 runonce=$8"
      !else if "${PHASE}" == "ready"
        StrCpy $8 "unknown"
        ${if} $launchLink == $newStartMenuLink
          StrCpy $8 "link"
        ${elseIf} $launchLink == $appExe
          StrCpy $8 "exe"
        ${endIf}
        StrCpy $4 "$4 launch=$8"
        StrCpy $8 0
        ${if} ${FileExists} "$appExe"
          StrCpy $8 1
        ${endIf}
        StrCpy $4 "$4 exe=$8"
        StrCpy $8 0
        ${if} ${FileExists} "$newStartMenuLink"
          StrCpy $8 1
        ${endIf}
        StrCpy $4 "$4 menu=$8"
        StrCpy $8 0
        ${if} ${FileExists} "$newDesktopLink"
          StrCpy $8 1
        ${endIf}
        StrCpy $4 "$4 desktop=$8 keepShortcuts=$keepShortcuts"
        FindWindow $9 "Shell_TrayWnd"
        StrCpy $8 0
        ${if} $9 != 0
          StrCpy $8 1
        ${endIf}
        StrCpy $9 0
        !ifdef ONE_CLICK
          !ifdef RUN_AFTER_FINISH
            ${ifNot} ${Silent}
            ${orIf} ${isForceRun}
              StrCpy $9 1
            ${endIf}
          !else
            ${if} ${isForceRun}
              StrCpy $9 1
            ${endIf}
          !endif
        !else
          ${if} ${isForceRun}
          ${andIf} ${Silent}
            StrCpy $9 1
          ${endIf}
        !endif
        StrCpy $4 "$4 shell=$8 startapp=$9"
      !else
        StrCpy $4 "$4 first=${FIRST} loops=${LOOPS}"
      !endif
      ClearErrors
      FileOpen $1 "$0\orbit-desktop\logs\update-install.log" a
      ${ifNot} ${Errors}
        FileSeek $1 0 END $3
        ${ifNot} ${Errors}
        ${andIf} $3 >= 0
        ${andIf} $3 < 1048576
          StrLen $8 $4
          IntOp $8 $8 + 2
          IntOp $3 $3 + $8
          ${if} $3 <= 1048576
            FileWrite $1 "$4$\r$\n"
          ${endIf}
        ${endIf}
        FileClose $1
      ${endIf}
    ${endIf}
    Pop $9
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${endIf}
  ${if} $R4 == 1
    SetErrors
  ${else}
    ClearErrors
  ${endIf}
  Pop $R4
  Pop $R9
!endif
!macroend

!macro customInit
  ${if} ${isUpdated}
    !insertmacro winkUpdateTrace "init" "unknown" 0
    WriteRegStr HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_NAME}" '"$EXEPATH" --updated /S --force-run /D=$INSTDIR'
  ${endIf}
!macroend

!macro customInstall
  DeleteRegValue HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_NAME}"
  !insertmacro winkUpdateTrace "ready" "unknown" 0
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_NAME}"
  ${endIf}
!macroend

# The default check starts PowerShell up to three times, in the installer and again in the old uninstaller.
# Same steps and dialogs, but it reads process paths directly and stops only processes running from this install.
!macro winkFindInstallProcesses _KILL
  StrCpy $R0 1
  StrCpy $9 "$INSTDIR\"
  StrLen $7 $9
  System::Call 'kernel32::GetCurrentProcessId() i .r6'
  System::Alloc 16384
  Pop $8
  System::Call 'kernel32::K32EnumProcesses(p r8, i 16384, *i .r5) i .r0'
  ${if} $0 != 0
    IntOp $5 $5 / 4
    ${for} $4 1 $5
      IntOp $3 $4 - 1
      IntOp $3 $3 * 4
      IntPtrOp $3 $8 + $3
      System::Call '*$3(i .r3)'
      # PROCESS_QUERY_LIMITED_INFORMATION also opens elevated processes, so those still count as running.
      System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r3) p .r2'
      ${if} $3 != $6
      ${andIf} $2 != 0
        System::Call 'kernel32::QueryFullProcessImageNameW(p r2, i 0, w .r0, *i ${NSIS_MAX_STRLEN}) i .r1'
        StrCpy $0 $0 $7
        ${if} $1 != 0
        ${andIf} $0 == $9
          StrCpy $R0 0
          !if ${_KILL} == 1
            System::Call 'kernel32::OpenProcess(i 1, i 0, i r3) p .r1'
            ${if} $1 != 0
              System::Call 'kernel32::TerminateProcess(p r1, i 1)'
              System::Call 'kernel32::CloseHandle(p r1)'
            ${endIf}
          !endif
        ${endIf}
      ${endIf}
      ${if} $2 != 0
        System::Call 'kernel32::CloseHandle(p r2)'
      ${endIf}
    ${next}
  ${endIf}
  System::Free $8
!macroend

!macro customCheckAppRunning
!ifndef BUILD_UNINSTALLER
  Push $R2
  Push $R3
  StrCpy $R3 0
  !insertmacro winkUpdateTrace "check-begin" "unknown" 0
!endif
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  ${if} ${isUpdated}
    Sleep 300
  ${endIf}
  !insertmacro winkFindInstallProcesses 0
!ifndef BUILD_UNINSTALLER
  StrCpy $R2 $R0
!endif
  ${if} $R0 == 0
    ${if} ${isUpdated}
      Sleep 1000
    ${else}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
      Quit
    ${endIf}
    DetailPrint "$(appClosing)"
    !insertmacro winkFindInstallProcesses 1
    Sleep 300
    StrCpy $R1 0
    ${do}
      IntOp $R1 $R1 + 1
!ifndef BUILD_UNINSTALLER
      IntOp $R3 $R3 + 1
!endif
      !insertmacro winkFindInstallProcesses 0
      ${if} $R0 != 0
        ${exitDo}
      ${endIf}
      Sleep 1000
      !insertmacro winkFindInstallProcesses 1
      !insertmacro winkFindInstallProcesses 0
      ${if} $R0 != 0
        ${exitDo}
      ${endIf}
      DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
      Sleep 2000
      ${if} $R1 > 1
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2
        Quit
      ${endIf}
    ${loop}
  ${endIf}
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
!ifndef BUILD_UNINSTALLER
  !insertmacro winkUpdateTrace "check-end" "$R2" "$R3"
  Pop $R3
  Pop $R2
!endif
!macroend
