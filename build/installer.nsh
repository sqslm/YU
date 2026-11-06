; Installer hooks.
!macro customInstall
  ClearErrors
  FileOpen $R4 "$INSTDIR\resources\yu-library-upgrade-v1" w
  ${If} ${Errors}
    !insertmacro YuStop "无法记录卸载器的数据保护能力。 / Could not record library protection support."
  ${EndIf}
  FileWrite $R4 "1"
  FileClose $R4
  ; Preserve the builder's shortcut policy; only change icons on links it created.
  ${if} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\resources\shortcut.ico" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endif}
!macroend

; Copy one protected directory into the export the user chose, requiring the file
; that makes it readable. A category that is not installed copies nothing.
!macro YuExport SOURCE TARGET PROBE FAIL
  ${If} ${FileExists} "${SOURCE}\${PROBE}"
    ClearErrors
    CreateDirectory "${TARGET}"
    IfErrors ${FAIL}
    CopyFiles /SILENT "${SOURCE}\*.*" "${TARGET}"
    IfErrors ${FAIL}
    IfFileExists "${TARGET}\${PROBE}" 0 ${FAIL}
  ${ElseIf} ${FileExists} "${SOURCE}\*.*"
    Goto ${FAIL}
  ${EndIf}
!macroend

; A silent run cannot show a message, and a message box in a silent upgrade is
; just a hang: report the failure through the exit code instead.
!macro YuStop MESSAGE
  ${If} ${Silent}
    SetErrorLevel 2
    Quit
  ${EndIf}
  MessageBox MB_OK|MB_ICONSTOP "${MESSAGE}"
  Abort
!macroend

!macro YuCheckRegisteredUpgrade ROOT
  ReadRegStr $R4 ${ROOT} "${UNINSTALL_REGISTRY_KEY}" UninstallString
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${If} $R4 == ""
      ReadRegStr $R4 ${ROOT} "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    ${EndIf}
  !endif
  ${If} $R4 != ""
    ReadRegStr $R4 ${ROOT} "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R4 == ""
      !insertmacro YuStop "无法核实旧版安装目录，已停止升级。 / Cannot verify the previous installation directory."
    ${EndIf}
    ${IfNot} ${FileExists} "$R4\resources\yu-library-upgrade-v1"
      ${If} ${FileExists} "$R4\data\knowledge\*.*"
      ${OrIf} ${FileExists} "$R4\data\profile\*.*"
        !insertmacro YuStop "旧版卸载器无法保证保留知识库或画像。请先备份并移出这些数据库，再重试。原数据仍在 $R4\data。 / Back up and move the libraries out before retrying. Existing data was kept."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  !insertmacro YuCheckRegisteredUpgrade HKCU
  !insertmacro YuCheckRegisteredUpgrade HKLM
!macroend

; Fails when PATH resolves inside $INSTDIR, whatever spelling it was given. The
; call is inline because this macro only ever expands inside the uninstaller, and
; a helper function there would leave the installer build without a caller.
!macro YuOutsideInstall PATH INSIDE
  StrCpy $5 ""
  StrCpy $6 ""
  System::Call 'kernel32::CreateFileW(w "${PATH}", i 0, i 7, p 0, i 3, i 0x02000000, p 0) p .r7'
  StrCmp $7 "-1" ${INSIDE}
  System::Call 'kernel32::GetFinalPathNameByHandleW(p r7, t .r5, i 1024, i 0) i .r8'
  System::Call 'kernel32::CloseHandle(p r7)'
  IntCmp $8 0 ${INSIDE} ${INSIDE} 0
  IntCmp $8 1024 ${INSIDE} 0 ${INSIDE}
  System::Call 'kernel32::CreateFileW(w "$INSTDIR", i 0, i 7, p 0, i 3, i 0x02000000, p 0) p .r7'
  StrCmp $7 "-1" ${INSIDE}
  System::Call 'kernel32::GetFinalPathNameByHandleW(p r7, t .r6, i 1024, i 0) i .r8'
  System::Call 'kernel32::CloseHandle(p r7)'
  IntCmp $8 0 ${INSIDE} ${INSIDE} 0
  IntCmp $8 1024 ${INSIDE} 0 ${INSIDE}
  StrCmp $5 $6 ${INSIDE}
  StrCpy $6 "$6\"
  StrLen $8 $6
  StrCpy $8 $5 $8
  StrCmp $8 $6 ${INSIDE}
!macroend

; One job: let the downloaded speech models and the user's own data survive an
; update.
;
; The generated uninstaller deletes $INSTDIR wholesale (uninstaller.nsh ends with
; `RMDir /r $INSTDIR`), and the installer runs that uninstaller before it unpacks
; the new version. That is right for the app's own files — they are replaced
; anyway — but wrong for the three directories this app keeps next to itself:
; `models\` (a 100–230 MB download the user paid for), `data\chat` and the two
; libraries `data\knowledge` and `data\profile`, which only exist because the user
; wrote them.
;
; So: rename each to a sibling path on the same volume (instant, no copy), let the
; wipe happen, then rename it back. No register is used to remember the path — the
; parked folder is the state, so a half-finished install still ends up with the
; data one `Rename` away instead of losing it. Every park is all-or-nothing: a
; failure puts back what this run already moved and stops with the folder's path.
;
; A real uninstall asks once for all three, and refuses to run silently while any
; of them holds data: an answer cannot be guessed, and deleting the only copy of
; the user's cards because nobody could answer is not a default.

!macro customRemoveFiles
  Var /GLOBAL YuParkedMask
  ; Bitmask of what this run parked: 1 chat, 2 knowledge, 4 profile.
  StrCpy $YuParkedMask 0

  ${if} ${isUpdated}
    ; A parked name from an earlier attempt means the last run stopped in the
    ; middle: there may be a sibling folder, or a live directory that only holds
    ; what was left behind. Either way this run must not touch it — it stops
    ; before moving anything, with the path the user has to look at.
    ${If} ${FileExists} "$INSTDIR.chat-data"
      !insertmacro YuStop "Chat data from a previous interrupted update is still at $INSTDIR.chat-data. Restore it before retrying."
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR.knowledge-data"
      !insertmacro YuStop "Knowledge data from a previous interrupted update is still at $INSTDIR.knowledge-data. Restore it before retrying."
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR.profile-data"
      !insertmacro YuStop "Profile data from a previous interrupted update is still at $INSTDIR.profile-data. Restore it before retrying."
    ${EndIf}
    ; Chat and attachments live together in data\chat (SQLite includes attachments).
    IfFileExists "$INSTDIR\data\chat\*.*" 0 yu_park_knowledge
      ClearErrors
      Rename "$INSTDIR\data\chat" "$INSTDIR.chat-data"
      IfErrors 0 +2
        Abort "Cannot preserve chat data. Close YU and retry."
      IntOp $YuParkedMask $YuParkedMask | 1
    yu_park_knowledge:
    IfFileExists "$INSTDIR\data\knowledge\*.*" 0 yu_park_profile
      ClearErrors
      Rename "$INSTDIR\data\knowledge" "$INSTDIR.knowledge-data"
      IfErrors yu_park_knowledge_failed
      IntOp $YuParkedMask $YuParkedMask | 2
    Goto yu_park_profile
    yu_park_knowledge_failed:
      IntOp $R6 $YuParkedMask & 1
      StrCmp $R6 0 +3
        CreateDirectory "$INSTDIR\data"
        Rename "$INSTDIR.chat-data" "$INSTDIR\data\chat"
      Abort "Cannot preserve the knowledge base. Close YU and retry; its files are still at $INSTDIR\data\knowledge."
    yu_park_profile:
    IfFileExists "$INSTDIR\data\profile\*.*" 0 yu_parked
      ClearErrors
      Rename "$INSTDIR\data\profile" "$INSTDIR.profile-data"
      IfErrors yu_park_profile_failed
      IntOp $YuParkedMask $YuParkedMask | 4
    Goto yu_parked
    yu_park_profile_failed:
      ; Put back what this run moved, so nothing is left half-parked.
      IntOp $R6 $YuParkedMask & 2
      StrCmp $R6 0 +3
        CreateDirectory "$INSTDIR\data"
        Rename "$INSTDIR.knowledge-data" "$INSTDIR\data\knowledge"
      IntOp $R6 $YuParkedMask & 1
      StrCmp $R6 0 +3
        CreateDirectory "$INSTDIR\data"
        Rename "$INSTDIR.chat-data" "$INSTDIR\data\chat"
      Abort "Cannot preserve the profile. Close YU and retry; its files are still at $INSTDIR\data\profile."
    yu_parked:
  ${else}
    ; Any protected directory with content means the user has something to lose.
    StrCpy $R8 0
    IfFileExists "$INSTDIR\data\chat\*.*" 0 +2
      StrCpy $R8 1
    IfFileExists "$INSTDIR\data\knowledge\*.*" 0 +2
      StrCpy $R8 1
    IfFileExists "$INSTDIR\data\profile\*.*" 0 +2
      StrCpy $R8 1
    StrCmp $R8 0 yu_wipe
    ; No silent, destructive default when the user cannot answer the question.
    IfSilent 0 yu_ask
      Abort "Interactive uninstall is required to choose whether to preserve chat, knowledge and profile data."
    yu_ask:
    MessageBox MB_YESNOCANCEL|MB_ICONQUESTION "是否保留并迁移对话、知识库和画像？$\r$\nYes：选择保存目录，迁移成功后卸载。$\r$\nNo：删除对话、知识库和画像后卸载。$\r$\nCancel：取消卸载。$\r$\n$\r$\nKeep chats, knowledge base and profile? Yes: choose a backup folder. No: delete them. Cancel: stop uninstalling." IDYES yu_choose IDNO yu_wipe
      Abort
    yu_choose:
      nsDialogs::SelectFolderDialog "选择保存对话、知识库和画像的目录 / Choose a backup folder" ""
      Pop $R1
      StrCmp $R1 "error" 0 +2
        Abort
      StrCmp $R1 "" 0 +2
        Abort
      GetFullPathName $R1 "$R1"
      StrCmp $R1 "" 0 +2
        Abort "Cannot resolve the backup folder. Original data has been kept."
      !insertmacro YuOutsideInstall "$R1" yu_inside
      StrCpy $R1 "$R1\YU-data"
      ; NSIS string compares ignore case, which is what keeps a differently-cased
      ; spelling of the installation from slipping past this check.
      GetFullPathName $R2 "$INSTDIR"
      StrCpy $R2 "$R2\"
      StrLen $R3 $R2
      StrCpy $R4 $R1 $R3
      StrCmp $R4 $R2 0 yu_destination
    yu_inside:
        MessageBox MB_OK|MB_ICONEXCLAMATION "保存目录必须位于安装目录之外。 / Choose a folder outside the installation."
        Goto yu_choose
    yu_destination:
      IfFileExists "$R1" 0 yu_export
        MessageBox MB_OK|MB_ICONEXCLAMATION "目标目录 YU-data 已存在，请选择其他目录，避免覆盖。 / Backup already exists; choose another folder."
        Goto yu_choose
    yu_export:
      ClearErrors
      CreateDirectory "$R1"
      IfErrors yu_export_failed
      !insertmacro YuExport "$INSTDIR\data\chat" "$R1\chat" "chats.db" yu_export_failed
      !insertmacro YuExport "$INSTDIR\data\knowledge" "$R1\knowledge" "knowledge.db" yu_export_failed
      !insertmacro YuExport "$INSTDIR\data\profile" "$R1\profile" "profile.db" yu_export_failed
      Goto yu_wipe
    yu_export_failed:
      RMDir /r "$R1"
      MessageBox MB_OK|MB_ICONSTOP "迁移失败，已取消卸载，原数据仍保留在 $INSTDIR\data。 / Copy failed. Uninstall cancelled; original data is intact."
      Abort
  ${endif}

  yu_wipe:
  IfFileExists "$INSTDIR\models\*.*" 0 typeless_wipe
    RMDir /r "$INSTDIR.models"
    Rename "$INSTDIR\models" "$INSTDIR.models"
  typeless_wipe:

  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"
      Push ""
      Call un.restoreFiles
      Pop $R0

      ; Nothing was wiped, so the parked directories go straight back.
      IntOp $R6 $YuParkedMask & 1
      StrCmp $R6 0 +3
        CreateDirectory "$INSTDIR\data"
        Rename "$INSTDIR.chat-data" "$INSTDIR\data\chat"
      IntOp $R6 $YuParkedMask & 2
      StrCmp $R6 0 +3
        CreateDirectory "$INSTDIR\data"
        Rename "$INSTDIR.knowledge-data" "$INSTDIR\data\knowledge"
      IntOp $R6 $YuParkedMask & 4
      StrCmp $R6 0 +3
        CreateDirectory "$INSTDIR\data"
        Rename "$INSTDIR.profile-data" "$INSTDIR\data\profile"
      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}
  ${endif}

  ; Move out of $INSTDIR so it can be removed
  SetOutPath $TEMP
  RMDir /r $INSTDIR

  ${if} ${isUpdated}
    IntOp $R6 $YuParkedMask & 1
    StrCmp $R6 0 +6
      CreateDirectory "$INSTDIR\data"
      ClearErrors
      Rename "$INSTDIR.chat-data" "$INSTDIR\data\chat"
      IfErrors 0 +2
        Abort "Chat data is preserved next to the installation at $INSTDIR.chat-data. Restore it before launching YU."
    IntOp $R6 $YuParkedMask & 2
    StrCmp $R6 0 +6
      CreateDirectory "$INSTDIR\data"
      ClearErrors
      Rename "$INSTDIR.knowledge-data" "$INSTDIR\data\knowledge"
      IfErrors 0 +2
        Abort "The knowledge base is preserved next to the installation at $INSTDIR.knowledge-data. Restore it before launching YU."
    IntOp $R6 $YuParkedMask & 4
    StrCmp $R6 0 +6
      CreateDirectory "$INSTDIR\data"
      ClearErrors
      Rename "$INSTDIR.profile-data" "$INSTDIR\data\profile"
      IfErrors 0 +2
        Abort "The profile is preserved next to the installation at $INSTDIR.profile-data. Restore it before launching YU."
  ${endif}

  IfFileExists "$INSTDIR.models\*.*" 0 typeless_done
    CreateDirectory "$INSTDIR"
    Rename "$INSTDIR.models" "$INSTDIR\models"
  typeless_done:
!macroend
