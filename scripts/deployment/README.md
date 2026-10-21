# Machine-local deployment

`redeploy.py` targets this machine's fixed Docker deployment, not general setup.
Read its code/tests and `python3 scripts/deployment/redeploy.py --help` before use.
Private state and logs stay in ignored `.local-deploy/state/`; never commit them.

```sh
python3 -m unittest discover -s scripts/deployment -p 'test_*.py'
python3 scripts/deployment/redeploy.py --check
python3 scripts/deployment/redeploy.py --prepare
```

Checks require clean committed source. Preparation does not stop production.
`--deploy` and `--recover` require explicit deployment approval; do not run other
writers/deployers concurrently. Deployment takes an offline snapshot before
conversion. After ingress opens, recovery must not restore an older database.
