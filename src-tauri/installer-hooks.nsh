; Instalar `pulso` en la terminal: pulso.exe viaja con el programa; aquí solo se añade su carpeta al PATH del usuario.
; Al desinstalar se deshace. Es lo mismo que hace el comando «Instalar el comando pulso» dentro de la app.
!macro NSIS_HOOK_POSTINSTALL
  ; Versiones anteriores creaban pulso.cmd; el comando ahora es pulso.exe y el .cmd lo taparía.
  Delete "$INSTDIR\pulso.cmd"
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$INSTDIR'; $$p=[Environment]::GetEnvironmentVariable('Path','User'); $$a=@(); if($$p){$$a=@($$p -split ';' | Where-Object { $$_ })}; if($$a -notcontains $$d){[Environment]::SetEnvironmentVariable('Path',(($$a+$$d) -join ';'),'User')}"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d='$INSTDIR'; $$p=[Environment]::GetEnvironmentVariable('Path','User'); if($$p){[Environment]::SetEnvironmentVariable('Path',((@($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$d })) -join ';'),'User')}"`
  Pop $0
  Delete "$INSTDIR\pulso.cmd"
!macroend
