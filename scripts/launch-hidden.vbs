' scripts/launch-hidden.vbs - starts Lantern with no console window.
' Used by the desktop and Start menu shortcuts and by lantern:// links.
' Everything it is given is passed on to scripts/launch.mjs.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
shell.CurrentDirectory = root
cmd = "node """ & here & "\launch.mjs"""
For Each a In WScript.Arguments
  cmd = cmd & " """ & Replace(a, """", "") & """"
Next
shell.Run cmd, 0, False
