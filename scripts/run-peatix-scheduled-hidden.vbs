' Runs run-peatix-scheduled.cmd with no console window (window style 0 = hidden).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\run-peatix-scheduled.cmd""", 0, True
