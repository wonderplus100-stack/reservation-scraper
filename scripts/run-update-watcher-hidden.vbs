' Runs run-update-watcher.cmd with no console window (window style 0 = hidden). Does not wait (it never ends).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\run-update-watcher.cmd""", 0, False
