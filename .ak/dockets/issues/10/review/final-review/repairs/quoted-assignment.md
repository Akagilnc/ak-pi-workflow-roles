# Repair packet: quoted conventional assignment scanning

At current HEAD, make the existing token-assignment scanner consume the complete single- or double-quoted assigned value including whitespace, so no suffix of `password="correct horse battery staple"` or equivalent reaches promotion. Preserve unquoted/provider/header rules and one scanner. Add focused scanner plus existing promotion/admission regression, regenerate dist, run focused/typecheck/full, one forward commit and Receipt. Do not inspect sessions.
