---
title: NPM + 1Password
description: Publishing to npm using 1Password for OTP
---

# NPM + 1Password

- Use 1password skill; `op` commands inside a fresh tmux session.
- Sign in: `eval "$(op signin --account <your-1password-account>)"`.
- OTP: `op read 'op://<vault>/<item>/one-time password?attribute=otp'`.
- Publish: `npm publish --access public --otp="<otp>"`. Kill tmux after.
