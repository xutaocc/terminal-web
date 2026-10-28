#!/usr/bin/env python3
"""Build the remote-only distribution from an explicit credential-free file list."""
import argparse
import hashlib
from pathlib import Path
import zipfile

FILES = (
    'scripts/twssh/package.json',
    'scripts/twssh/twssh.mjs',
    'scripts/twssh/transport.mjs',
    'scripts/twssh/README.md',
    'skills/terminal-web-remote/SKILL.md',
    'docs/远程Agent-部署与使用.md',
    'docs/winssh-远程Agent持久终端设计.md',
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    output = args.output.resolve()
    for name in FILES:
        if not (root / name).is_file():
            parser.error(f'Missing distribution file: {name}')
    if output in {(root / name).resolve() for name in FILES}:
        parser.error('Output must not overwrite a source file')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            entry = zipfile.ZipInfo('terminal-web-remote/' + name)
            entry.create_system = 3
            entry.external_attr = (0o100755 if name.endswith('twssh.mjs') else 0o100644) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, (root / name).read_bytes())
        archive.writestr('terminal-web-remote/START_HERE.txt',
                        'Read docs/远程Agent-部署与使用.md for deployment and usage.\n'
                        'Client: scripts/twssh (Node.js 20+, no runtime dependencies).\n'
                        'Agent instructions: skills/terminal-web-remote/SKILL.md.\n'
                        'Configure your own Windows URL and Token file. No credentials are included.\n'
                        'HTTP + Token is intended for trusted networks or VPNs.\n'
                        'Windows server and browser host must be upgraded separately via Git.\n')
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('ZIP verification failed')
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + '.sha256').write_text(
        f'{digest}  {output.name}\n', encoding='ascii')
    print(f'{output}\nSHA256 {digest}')


if __name__ == '__main__':
    main()
