add project context here

## Task Tracking

ALWAYS use the chalk CLI tool for ALL task operations.

chalk ready                          # First command when picking up work — shows unblocked tasks by priority
chalk ready --parent=epic_0c4d       # Find available work under a specific epic
chalk show <id>                      # View full task details
chalk list --status=open             # List tasks with filters
chalk update <id> --status=in_progress  # Claim a task
chalk close <id>                     # Mark done (auto-unblocks dependents)
chalk create "Title" --parent=<id>   # Create sub-task
If you have attempted to use chalk and it is not available, tasks can be read manually. Tasks are stored as markdown files with YAML frontmatter at .chalk/tasks/<type>_<hex>.md (e.g. tasks/bug_5cc8.md). Closed tasks move to .chalk/tasks/closed/.

Workflow

Setup tracking: If there is not an existing task, create one with chalk create
Plan First: Write plan to the task file with checkable items
Verify Plan: Check in before starting implementation
Create a branch: Put all code fixes into a new branch so they can be tracked and merged
Track Progress: Mark items complete as you go
Explain Changes: High-level summary at each step
Document Results: Add review section to the task file
Capture Lessons: Update LEARNINGS.md after corrections