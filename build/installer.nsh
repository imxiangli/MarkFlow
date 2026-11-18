; Extra registry entries for the NSIS installer (Windows).
; Adds "Open with MarkFlow" to the context menu of folders, folder backgrounds and files
; (any text or code file can be opened; MarkFlow never becomes their default app).
; SHCTX follows the install mode chosen by the user (current user / all users).

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\Directory\shell\MarkFlow" "" "Open with MarkFlow"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\MarkFlow" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\Directory\shell\MarkFlow\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\MarkFlow" "" "Open with MarkFlow"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\MarkFlow" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\MarkFlow\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
  WriteRegStr SHCTX "Software\Classes\*\shell\MarkFlow" "" "Open with MarkFlow"
  WriteRegStr SHCTX "Software\Classes\*\shell\MarkFlow" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\*\shell\MarkFlow\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\MarkFlow"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\MarkFlow"
  DeleteRegKey SHCTX "Software\Classes\*\shell\MarkFlow"
!macroend
