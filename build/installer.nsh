; Installer hooks.
!macro customInstall
  ; Preserve the builder's shortcut policy; only change icons on links it created.
  ${if} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\resources\shortcut.ico" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endif}
!macroend
;
; One job: let the downloaded speech models survive an update.
;
; The generated uninstaller deletes $INSTDIR wholesale (uninstaller.nsh ends with
; `RMDir /r $INSTDIR`), and the installer runs that uninstaller before it unpacks
; the new version. That is right for the app's own files — they are replaced
; anyway — but wrong for `models\`, which holds a 100–230 MB download the user
; paid for and which the app deliberately keeps next to itself instead of on C:.
;
; So: rename the folder to a sibling path on the same volume (instant, no copy),
; let the wipe happen, then rename it back. No register is used to remember the
; path — the parked folder is the state, so a half-finished install still ends up
; with the weights one `Rename` away instead of losing them.

!macro customRemoveFiles
  ; Chat and attachments live together in data\chat (SQLite includes attachments).
  ; The updater must preserve it without prompting. A real uninstall must ask.
  ${if} ${isUpdated}
    IfFileExists "$INSTDIR\data\chat\*.*" 0 yu_chat_ready
      IfFileExists "$INSTDIR.chat-data\*.*" 0 +2
        Abort "Chat data from a previous interrupted update still exists next to the installation. Restore it before retrying."
      ClearErrors
      Rename "$INSTDIR\data\chat" "$INSTDIR.chat-data"
      IfErrors 0 yu_chat_ready
        Abort "Cannot preserve chat data. Close YU and retry."
  ${else}
    IfFileExists "$INSTDIR\data\chat\*.*" 0 yu_chat_ready
    ; No silent, destructive default when the user cannot answer the question.
    IfSilent 0 +2
      Abort "Interactive uninstall is required to choose whether to preserve chat data."
    MessageBox MB_YESNOCANCEL|MB_ICONQUESTION "是否保留并迁移对话和附件？$\r$\nYes：选择保存目录，迁移成功后卸载。$\r$\nNo：删除对话及附件后卸载。$\r$\nCancel：取消卸载。$\r$\n$\r$\nKeep chats and attachments? Yes: choose a backup folder. No: delete them. Cancel: stop uninstalling." IDYES yu_chat_choose IDNO yu_chat_ready
      Abort
    yu_chat_choose:
      nsDialogs::SelectFolderDialog "选择保存对话和附件的目录 / Choose a backup folder" ""
      Pop $R1
      StrCmp $R1 "error" 0 +2
        Abort
      StrCmp $R1 "" 0 +2
        Abort
      GetFullPathName $R1 "$R1"
      StrCmp $R1 "" 0 +2
        Abort "Cannot resolve the backup folder. Original chat data has been kept."
      StrCpy $R1 "$R1\YU-chat-data"
      GetFullPathName $R2 "$INSTDIR"
      StrCpy $R2 "$R2\"
      StrLen $R3 $R2
      StrCpy $R4 $R1 $R3
      StrCmp $R4 $R2 0 yu_chat_destination
        MessageBox MB_OK|MB_ICONEXCLAMATION "保存目录必须位于安装目录之外。 / Choose a folder outside the installation."
        Goto yu_chat_choose
    yu_chat_destination:
      IfFileExists "$R1" 0 yu_chat_copy
        MessageBox MB_OK|MB_ICONEXCLAMATION "目标目录 YU-chat-data 已存在，请选择其他目录，避免覆盖。 / Backup already exists; choose another folder."
        Goto yu_chat_choose
    yu_chat_copy:
      ClearErrors
      CreateDirectory "$R1"
      CopyFiles /SILENT "$INSTDIR\data\chat\*.*" "$R1"
      IfErrors yu_chat_copy_failed
      IfFileExists "$R1\chats.db" yu_chat_ready yu_chat_copy_failed
    yu_chat_copy_failed:
        MessageBox MB_OK|MB_ICONSTOP "迁移失败，已取消卸载，原对话数据仍保留。 / Copy failed. Uninstall cancelled; original data is intact."
        Abort
  ${endif}
  yu_chat_ready:
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

      IfFileExists "$INSTDIR.chat-data\*.*" 0 +3
        CreateDirectory "$INSTDIR\data"
        Rename "$INSTDIR.chat-data" "$INSTDIR\data\chat"
      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}
  ${endif}

  ; Move out of $INSTDIR so it can be removed
  SetOutPath $TEMP
  RMDir /r $INSTDIR

  ${if} ${isUpdated}
    IfFileExists "$INSTDIR.chat-data\*.*" 0 yu_chat_restored
      CreateDirectory "$INSTDIR\data"
      ClearErrors
      Rename "$INSTDIR.chat-data" "$INSTDIR\data\chat"
      IfErrors 0 yu_chat_restored
        Abort "Chat data is preserved next to the installation as .chat-data. Restore it before launching YU."
    yu_chat_restored:
  ${endif}

  IfFileExists "$INSTDIR.models\*.*" 0 typeless_done
    CreateDirectory "$INSTDIR"
    Rename "$INSTDIR.models" "$INSTDIR\models"
  typeless_done:
!macroend
