# Specimens

These are examples of what the bootstrap WRITES, not files it copies. Nothing here
is installed into a project.

They use an invented project — a tide-table service called Ebb — precisely so that
nobody mistakes a specimen for a starting point worth editing. If you find yourself
editing one of these, you are in the wrong directory: the real files are written by
the interview, against your project.

## If you change these specimens

`BOOTSTRAP.md`'s verification step greps an installed project for the specimen
strings that must never leak into it — currently the invented project's name and
the worked example's stack terms. That list is written out by hand there.

If you rename the specimen project or change what `examples/` demonstrates, update
that grep in the same commit. A leak check whose pattern list no longer matches the
specimens passes everything, which is indistinguishable from a clean install.
