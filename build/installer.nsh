# An update removes the old app before copying the new one, so finish an interrupted one at next sign-in.
!define UPDATE_RUN_ONCE_KEY "Software\Microsoft\Windows\CurrentVersion\RunOnce"
!define UPDATE_RUN_ONCE_NAME "${PRODUCT_NAME} update"

!macro customInit
  ${if} ${isUpdated}
    WriteRegStr HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_NAME}" '"$EXEPATH" --updated /S --force-run /D=$INSTDIR'
  ${endIf}
!macroend

!macro customInstall
  DeleteRegValue HKCU "${UPDATE_RUN_ONCE_KEY}" "${UPDATE_RUN_ONCE_NAME}"
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
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  ${if} ${isUpdated}
    Sleep 300
  ${endIf}
  !insertmacro winkFindInstallProcesses 0
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
!macroend
