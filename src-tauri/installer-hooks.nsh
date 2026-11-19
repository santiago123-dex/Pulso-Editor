; Instalar `pulso` en la terminal: crea pulso.cmd junto al programa y añade la carpeta al PATH del usuario.
; Al desinstalar se deshace. Es lo mismo que hace el comando «Instalar el comando pulso» dentro de la app.
!macro NSIS_HOOK_POSTINSTALL
  FileOpen $0 "$INSTDIR\pulso.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 'start "" "%~dp0pulso-editor.exe" %*$\r$\n'
  FileClose $0
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$INSTDIR'; $$p=[Environment]::GetEnvironmentVariable('Path','User'); $$a=@(); if($$p){$$a=@($$p -split ';' | Where-Object { $$_ })}; if($$a -notcontains $$d){[Environment]::SetEnvironmentVariable('Path',(($$a+$$d) -join ';'),'User')}"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$INSTDIR'; $$p=[Environment]::GetEnvironmentVariable('Path','User'); if($$p){[Environment]::SetEnvironmentVariable('Path',((@($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$d })) -join ';'),'User')}"`
  Pop $0
  Delete "$INSTDIR\pulso.cmd"
!macroend
