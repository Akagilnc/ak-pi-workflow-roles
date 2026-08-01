# 0018: Activation fails closed

A role activation either completes lawfully or loudly terminates the whole
invocation — never an uncaged run; the shared registry envelope owns this,
roles never do. (Pi treats session_start errors as non-fatal, so without the
envelope every role reinvents its own latch.)
