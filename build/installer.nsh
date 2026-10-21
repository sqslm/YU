; Installer hooks.
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
      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}
  ${endif}

  ; Move out of $INSTDIR so it can be removed
  SetOutPath $TEMP
  RMDir /r $INSTDIR

  IfFileExists "$INSTDIR.models\*.*" 0 typeless_done
    CreateDirectory "$INSTDIR"
    Rename "$INSTDIR.models" "$INSTDIR\models"
  typeless_done:
!macroend
