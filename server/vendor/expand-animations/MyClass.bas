' MyClass headless adapter. The ExpandAnimations engine is in the adjacent
' LGPL-3.0-or-later module. Do not execute document macros or update links.
Sub Convert
    On Error GoTo Failed
    Dim doc As Object
    Dim props(3) As New com.sun.star.beans.PropertyValue
    props(0).Name = "Hidden"
    props(0).Value = True
    props(1).Name = "ReadOnly"
    props(1).Value = False ' The input is already a private per-job copy.
    props(2).Name = "MacroExecutionMode"
    props(2).Value = 0 ' com.sun.star.document.MacroExecMode.NEVER_EXECUTE
    props(3).Name = "UpdateDocMode"
    props(3).Value = 0 ' com.sun.star.document.UpdateDocMode.NO_UPDATE
    doc = StarDesktop.loadComponentFromURL(ConvertToURL(Environ("MYCLASS_ANIMATION_INPUT")), "_blank", 0, props())
    If IsNull(doc) Or IsEmpty(doc) Then Error 1001
    If Not doc.supportsService("com.sun.star.presentation.PresentationDocument") Then Error 1002

    ExpandAnimations.initializeAnimationTypes()
    slideCount = doc.getDrawPages().getCount()
    stateCount = 0
    unsupported = 0
    statePages = ""
    For i = 0 To slideCount - 1
        slide = doc.getDrawPages().getByIndex(i)
        If slide.Visible Then
            count = 1
            If ExpandAnimations.hasAnimation(slide) Then
                If Not ExpandAnimations.hasNoSupportedAnimationTargets(slide) Then
                    count = ExpandAnimations.countAnimationSteps(slide)
                End If
                If ExpandAnimations.hasUnsupportedAnimation(slide) Then unsupported = unsupported + 1
            End If
            stateCount = stateCount + count
            For stateIndex = 1 To count
                If Len(statePages) > 0 Then statePages = statePages & ","
                statePages = statePages & CStr(i + 1)
            Next stateIndex
        End If
    Next i
    If stateCount < 1 Then Error 1003
    If stateCount > CLng(Environ("MYCLASS_ANIMATION_MAX_STATES")) Then
        WriteReport "ERROR" & Chr(10) & "Too many animation states; limit=" & Environ("MYCLASS_ANIMATION_MAX_STATES")
        GoTo Finished
    End If

    ' Convert to real ODP before expanding; never rename PPT/PPTX bytes to .odp.
    doc.storeAsURL(ConvertToURL(Environ("MYCLASS_ANIMATION_ODP")), Array(ExpandAnimations.makePropertyValue("FilterName", "impress8"), ExpandAnimations.makePropertyValue("Overwrite", True)))
    ExpandAnimations.expandDocument(doc)
    stateCount = doc.getDrawPages().getCount()
    ExpandAnimations.exportToPDF(doc, ConvertToURL(Environ("MYCLASS_ANIMATION_OUTPUT")))
    WriteReport "OK" & Chr(10) & CStr(slideCount) & Chr(10) & CStr(stateCount) & Chr(10) & CStr(unsupported) & Chr(10) & statePages
    GoTo Finished
Failed:
    errorMessage = "Basic error " & CStr(Err) & ": " & Error$
    On Error Resume Next
    WriteReport "ERROR" & Chr(10) & errorMessage
Finished:
    On Error Resume Next
    doc.close(True)
    StarDesktop.terminate()
End Sub

Sub WriteReport(message As String)
    channel = FreeFile
    Open Environ("MYCLASS_ANIMATION_RESULT") For Output As #channel
    Print #channel, message
    Close #channel
End Sub
