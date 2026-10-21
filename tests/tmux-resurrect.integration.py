# Run with python3; requires installed tmux-resurrect and a UTF-8 locale.
# Uses a private socket and snapshot directory; never kills the default server.
import subprocess, tempfile, os, time, sys
from pathlib import Path
root=Path(tempfile.mkdtemp(prefix='tw-resurrect-')).resolve()
sock=str(root/'tmux.sock')
directory=root/'中文目录'; directory.mkdir()
backup=root/'snapshots'
plugin=Path.home()/'.tmux/plugins/tmux-resurrect'
config=root/'tmux.conf'
config.write_text(f"set -g default-shell /bin/sh\nset -g status off\nset -g @resurrect-dir '{backup}'\nset -g @resurrect-capture-pane-contents on\nset -g @resurrect-processes false\nrun-shell '{plugin}/resurrect.tmux'\n")
locale = 'en_US.UTF-8' if sys.platform == 'darwin' else 'C.UTF-8'
env={**os.environ,'LANG':locale,'LC_ALL':locale}
def tmux(*args):return subprocess.check_output(['tmux','-S',sock,*args],text=True,env=env).strip()
def script(name):
    local={**env,'TMUX':tmux('display-message','-p','#{socket_path},#{pid},0')}
    subprocess.run([str(plugin/'scripts'/name),'quiet'],env=local,check=True,timeout=25,stdout=subprocess.DEVNULL)
try:
    tmux('-f',str(config),'new-session','-d','-s','verify','-c',str(directory))
    tmux('send-keys','-t','verify',"printf 'TW_RESTORE_验证成功\\n'",'Enter')
    time.sleep(.3)
    script('save.sh')
    assert 'pane\tverify\t' in (backup/'last').read_text()
    tmux('kill-server')
    tmux('-f',str(config),'new-session','-d','-s','bootstrap')
    script('restore.sh')
    for _ in range(50):
        contents=tmux('capture-pane','-p','-S','-','-t','verify')
        if 'TW_RESTORE_验证成功' in contents:break
        time.sleep(.1)
    assert 'TW_RESTORE_验证成功' in contents,'pane text missing'
    assert tmux('display-message','-p','-t','verify','#{pane_current_path}')==str(directory)
    print('PASS: isolated tmux loss/recreation, saved terminal text and Chinese working directory restored')
finally:
    subprocess.run(['tmux','-S',sock,'kill-server'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    import shutil;shutil.rmtree(root)
