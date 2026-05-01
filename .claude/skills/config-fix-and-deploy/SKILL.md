---
name: config-fix-and-deploy
description: Fix configuration issues and deploy changes
when_to_use: When configuration problems arise and targeted fixes are needed
allowed-tools:
  - Bash
  - Read
  - Edit
---

# Fix Configuration Issues and Deploy Changes

This skill helps resolve configuration problems by reading relevant files, applying targeted fixes, and verifying the changes.

## Steps

1. **Run initial setup commands**
   - Activate conda environment: `conda activate aiagent`
   - Verify current state: `git status`

2. **Read multiple configuration and code files**
   - Use Read tool to examine configuration files
   - Identify the specific issue causing the problem

3. **Apply targeted edit to fix issue**
   - Use Edit tool with minimal changes
   - Ensure the fix addresses the root cause

4. **Write updated configuration or script**
   - Create or update necessary files
   - Use Write tool for new files

5. **Execute verification and deployment commands**
   - Run verification tests
   - Commit and push changes if needed
   - Verify the fix resolves the issue
