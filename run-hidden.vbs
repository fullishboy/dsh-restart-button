' Launch a command with no console window at all.
' Task Scheduler still creates the process on the interactive desktop, so the app
' that follows stays visible; only this launcher's own window is suppressed.
' Arguments: 1 = node path, 2 = script path (remaining args are appended).
Option Explicit

Dim shell, node, script, cmd, extra, i
If WScript.Arguments.Count < 2 Then
  WScript.Quit 2
End If

node = WScript.Arguments.Item(0)
script = WScript.Arguments.Item(1)
extra = ""
For i = 2 To WScript.Arguments.Count - 1
  extra = extra & " " & Chr(34) & WScript.Arguments.Item(i) & Chr(34)
Next

Set shell = CreateObject("WScript.Shell")
cmd = Chr(34) & node & Chr(34) & " " & Chr(34) & script & Chr(34) & extra
' 0 = hidden window, False = do not wait for it to finish.
shell.Run cmd, 0, False
