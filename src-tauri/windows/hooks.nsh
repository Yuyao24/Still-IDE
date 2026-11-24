; Windows caches app icons by file path, so after an update that changes the icon the
; taskbar, Start menu and desktop shortcuts can keep showing the old one. Ask the shell
; to drop its cached icons once the new files are in place.
!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
  IfFileExists "$SYSDIR\ie4uinit.exe" 0 +2
    nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend
