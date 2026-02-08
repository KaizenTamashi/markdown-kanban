export interface KanbanTask {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  priority?: 'low' | 'medium' | 'high';
  workload?: 'Easy' | 'Normal' | 'Hard' | 'Extreme';
  dueDate?: string;
  startDate?: string;
  defaultExpanded?: boolean;
  steps?: Array<{ text: string; completed: boolean }>;
  ac?: Array<{ text: string; completed: boolean }>;
  verify?: Array<{ text: string; completed: boolean }>;
  files?: string;
}

export interface KanbanColumn {
  id: string;
  title: string;
  tasks: KanbanTask[];
  archived?: boolean;
}

export interface KanbanBoard {
  title: string;
  columns: KanbanColumn[];
  nextId: number;
}

type ChecklistKey = 'steps' | 'ac' | 'verify';

export class MarkdownKanbanParser {
  private static generateId(): string {
    return Math.random().toString(36).substr(2, 9);
  }

  static parseMarkdown(content: string): KanbanBoard {
    const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const board: KanbanBoard = {
      title: '',
      columns: [],
      nextId: 1
    };

    // Parse counter from <!-- next-id: N --> comment
    const counterMatch = content.match(/<!--\s*next-id:\s*(\d+)\s*-->/);
    if (counterMatch) {
      board.nextId = parseInt(counterMatch[1]);
    }

    let currentColumn: KanbanColumn | null = null;
    let currentTask: KanbanTask | null = null;
    let inTaskBody = false;
    let inCodeBlock = false;
    let activeListKey: ChecklistKey | null = null;
    let collectingDescription = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Skip HTML comment lines (e.g. <!-- next-id: N -->)
      if (trimmedLine.startsWith('<!--') && trimmedLine.endsWith('-->')) {
        continue;
      }

      // Track code blocks
      if (trimmedLine.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) {
        continue;
      }

      // Parse board title
      if (trimmedLine.startsWith('# ') && !board.title) {
        board.title = trimmedLine.substring(2).trim();
        this.finalizeCurrentTask(currentTask, currentColumn);
        currentTask = null;
        inTaskBody = false;
        activeListKey = null;
        collectingDescription = false;
        continue;
      }

      // Parse column title
      if (trimmedLine.startsWith('## ')) {
        this.finalizeCurrentTask(currentTask, currentColumn);
        currentTask = null;
        if (currentColumn) {
          board.columns.push(currentColumn);
        }

        let columnTitle = trimmedLine.substring(3).trim();
        let isArchived = false;

        if (columnTitle.endsWith('[Archived]')) {
          isArchived = true;
          columnTitle = columnTitle.replace(/\s*\[Archived\]$/, '').trim();
        }

        currentColumn = {
          id: this.generateId(),
          title: columnTitle,
          tasks: [],
          archived: isArchived
        };
        inTaskBody = false;
        activeListKey = null;
        collectingDescription = false;
        continue;
      }

      // Parse task title (### format or - format)
      if (this.isTaskTitle(line, trimmedLine)) {
        this.finalizeCurrentTask(currentTask, currentColumn);

        if (currentColumn) {
          let taskTitle = '';

          if (trimmedLine.startsWith('### ')) {
            taskTitle = trimmedLine.substring(4).trim();
          } else {
            taskTitle = trimmedLine.substring(2).trim();
            if (taskTitle.startsWith('[ ] ') || taskTitle.startsWith('[x] ')) {
              taskTitle = taskTitle.substring(4).trim();
            }
          }

          // New format: extract TSK_N prefix from title
          const tskMatch = taskTitle.match(/^(TSK[_-]\d+)\s+(.*)$/);

          currentTask = {
            id: tskMatch ? tskMatch[1] : this.generateId(),
            title: tskMatch ? tskMatch[2] : taskTitle,
            description: ''
          };
          inTaskBody = true;
          activeListKey = null;
          collectingDescription = false;
        }
        continue;
      }

      // Inside a task body — parse properties, metadata, sections
      if (currentTask && inTaskBody) {
        // Empty line — reset description collection but stay in task
        if (trimmedLine === '') {
          // If we were collecting description and hit empty line before a section,
          // just continue (allow blank lines in description area)
          continue;
        }

        // === NEW FORMAT: Blockquote metadata line ===
        // > tags | priority
        if (trimmedLine.startsWith('> ')) {
          const metaContent = trimmedLine.substring(2).trim();
          const parts = metaContent.split('|').map(p => p.trim());
          const tagsPart = parts[0];
          const priorityPart = parts.length > 1 ? parts[1] : null;

          if (tagsPart) {
            currentTask.tags = tagsPart.split(',').map(t => t.trim()).filter(t => t !== '');
          }
          if (priorityPart && ['low', 'medium', 'high'].includes(priorityPart.toLowerCase())) {
            currentTask.priority = priorityPart.toLowerCase() as 'low' | 'medium' | 'high';
          }
          collectingDescription = true;
          activeListKey = null;
          continue;
        }

        // === NEW FORMAT: Bold section headers ===
        // **AC:** / **Verify:** / **Steps:** / **Files:**
        const boldSectionMatch = trimmedLine.match(/^\*\*(AC|Verify|Steps|Files):\*\*\s*(.*)$/i);
        if (boldSectionMatch) {
          collectingDescription = false;
          const sectionName = boldSectionMatch[1].toLowerCase();
          const inlineValue = boldSectionMatch[2].trim();

          if (sectionName === 'files') {
            if (inlineValue) {
              currentTask.files = inlineValue;
            }
            activeListKey = null;
          } else if (sectionName === 'ac') {
            currentTask.ac = currentTask.ac || [];
            activeListKey = 'ac';
          } else if (sectionName === 'verify') {
            currentTask.verify = currentTask.verify || [];
            activeListKey = 'verify';
          } else if (sectionName === 'steps') {
            currentTask.steps = currentTask.steps || [];
            activeListKey = 'steps';
          }
          continue;
        }

        // === NEW FORMAT: Checklist items (normal indentation) ===
        // - [ ] item or - [x] item
        const checklistMatch = trimmedLine.match(/^-\s+\[([ x])\]\s+(.*)$/);
        if (checklistMatch && activeListKey) {
          collectingDescription = false;
          const targetList = currentTask[activeListKey];
          if (targetList) {
            targetList.push({
              text: checklistMatch[2].trim(),
              completed: checklistMatch[1] === 'x'
            });
          }
          continue;
        }

        // === OLD FORMAT: Task properties (  - key: value) ===
        const parsedKey = this.parseTaskProperty(line, currentTask);
        if (parsedKey !== false) {
          collectingDescription = false;
          if (parsedKey === 'steps' || parsedKey === 'ac' || parsedKey === 'verify') {
            activeListKey = parsedKey;
          } else {
            activeListKey = null;
          }
          continue;
        }

        // === OLD FORMAT: 6-space indented checklist items ===
        if (this.parseOldChecklistItem(line, currentTask, activeListKey)) {
          continue;
        }

        // Image markdown syntax as inline description
        const imageMatch = trimmedLine.match(/^!\[.*\]\(.*\)/);
        if (imageMatch) {
          currentTask.description = currentTask.description
            ? currentTask.description + '\n' + trimmedLine
            : trimmedLine;
          continue;
        }

        // === NEW FORMAT: Description paragraph ===
        // Collect plain text lines as description (between metadata blockquote and first bold section)
        if (collectingDescription && !activeListKey) {
          currentTask.description = currentTask.description
            ? currentTask.description + '\n' + trimmedLine
            : trimmedLine;
          continue;
        }

        // OLD FORMAT: Continuation lines for desc: (indented lines)
        if (currentTask.description !== undefined && line.match(/^\s{4,}/) && trimmedLine !== '') {
          currentTask.description = currentTask.description
            ? currentTask.description + '\n' + trimmedLine
            : trimmedLine;
          continue;
        }

        // Unrecognized line inside task body — finalize task and re-process line
        this.finalizeCurrentTask(currentTask, currentColumn);
        currentTask = null;
        inTaskBody = false;
        activeListKey = null;
        collectingDescription = false;
        i--;
      }
    }

    // Add last task and column
    this.finalizeCurrentTask(currentTask, currentColumn);
    if (currentColumn) {
      board.columns.push(currentColumn);
    }

    // Auto-assign TSK_N IDs to tasks that don't have one yet (uses counter, no scanning)
    for (const column of board.columns) {
      for (const task of column.tasks) {
        if (!task.id.match(/^TSK[_-]\d+$/)) {
          task.id = `TSK_${board.nextId}`;
          board.nextId++;
        }
      }
    }

    return board;
  }

  private static isTaskTitle(line: string, trimmedLine: string): boolean {
    // Exclude old-format property lines and step items
    if (line.startsWith('- ') &&
        (trimmedLine.match(/^\s*- (id|due|tags|priority|workload|steps|defaultExpanded|desc|ac|verify|files):/) ||
         line.match(/^\s{6,}- \[([ x])\]/))) {
      return false;
    }

    // Exclude new-format checklist items at root level
    if (trimmedLine.match(/^-\s+\[([ x])\]\s+/)) {
      return false;
    }

    // Exclude bold section headers
    if (trimmedLine.match(/^\*\*(AC|Verify|Steps|Files):\*\*/i)) {
      return false;
    }

    return (line.startsWith('- ') && !line.startsWith('  ')) ||
           trimmedLine.startsWith('### ');
  }

  private static parseTaskProperty(line: string, task: KanbanTask): string | false {
    const propertyMatch = line.match(/^\s+- (id|due|tags|priority|workload|steps|defaultExpanded|desc|ac|verify|files):\s*(.*)$/);
    if (!propertyMatch) return false;

    const [, propertyName, propertyValue] = propertyMatch;
    const value = propertyValue.trim();

    switch (propertyName) {
      case 'id':
        if (value) {
          task.id = value;
        }
        break;
      case 'due':
        task.dueDate = value;
        break;
      case 'tags':
        const tagsMatch = value.match(/\[(.*)\]/);
        if (tagsMatch) {
          task.tags = tagsMatch[1].split(',').map(tag => tag.trim());
        }
        break;
      case 'priority':
        if (['low', 'medium', 'high'].includes(value)) {
          task.priority = value as 'low' | 'medium' | 'high';
        }
        break;
      case 'workload':
        if (['Easy', 'Normal', 'Hard', 'Extreme'].includes(value)) {
          task.workload = value as 'Easy' | 'Normal' | 'Hard' | 'Extreme';
        }
        break;
      case 'defaultExpanded':
        task.defaultExpanded = value.toLowerCase() === 'true';
        break;
      case 'steps':
        task.steps = [];
        break;
      case 'ac':
        task.ac = [];
        break;
      case 'verify':
        task.verify = [];
        break;
      case 'files':
        task.files = value;
        break;
      case 'desc':
        if (value) {
          task.description = task.description
            ? task.description + '\n' + value
            : value;
        }
        break;
    }
    return propertyName;
  }

  private static parseOldChecklistItem(line: string, task: KanbanTask, listKey: ChecklistKey | null): boolean {
    if (!listKey) return false;

    const targetList = task[listKey];
    if (!targetList) return false;

    const stepMatch = line.match(/^\s{6,}- \[([ x])\]\s*(.*)$/);
    if (!stepMatch) return false;

    const [, checkmark, text] = stepMatch;
    targetList.push({
      text: text.trim(),
      completed: checkmark === 'x'
    });
    return true;
  }

  private static finalizeCurrentTask(task: KanbanTask | null, column: KanbanColumn | null): void {
    if (!task || !column) return;

    if (task.description) {
      task.description = task.description.trim();
      if (task.description === '') {
        delete task.description;
      }
    }
    column.tasks.push(task);
  }

  static generateMarkdown(board: KanbanBoard, taskHeaderFormat: 'title' | 'list' = 'title'): string {
    let markdown = `<!-- next-id: ${board.nextId} -->\n`;

    if (board.title) {
      markdown += `# ${board.title}\n\n`;
    }

    for (const column of board.columns) {
      const columnTitle = column.archived ? `${column.title} [Archived]` : column.title;
      markdown += `## ${columnTitle}\n\n`;

      for (const task of column.tasks) {
        // New format: TSK_N in title
        const idPrefix = task.id && task.id.match(/^TSK[_-]\d+$/) ? `${task.id} ` : '';

        if (taskHeaderFormat === 'title') {
          markdown += `### ${idPrefix}${task.title}\n`;
        } else {
          markdown += `- ${idPrefix}${task.title}\n`;
        }

        // Blockquote metadata line: > tags | priority
        const metaParts: string[] = [];
        if (task.tags && task.tags.length > 0) {
          metaParts.push(task.tags.join(', '));
        }
        if (task.priority) {
          metaParts.push(task.priority);
        }
        if (metaParts.length > 0) {
          markdown += `> ${metaParts.join(' | ')}\n`;
        }

        // Description paragraph
        if (task.description && task.description.trim() !== '') {
          markdown += `\n${task.description.trim()}\n`;
        }

        // Due date (preserved for backward compat — rare field)
        if (task.dueDate) {
          markdown += `\n**Due:** ${task.dueDate}\n`;
        }

        // Workload (preserved for backward compat — rare field)
        if (task.workload) {
          markdown += `\n**Workload:** ${task.workload}\n`;
        }

        // Steps checklist
        if (task.steps && task.steps.length > 0) {
          markdown += `\n**Steps:**\n`;
          for (const item of task.steps) {
            const checkbox = item.completed ? '[x]' : '[ ]';
            markdown += `- ${checkbox} ${item.text}\n`;
          }
        }

        // AC checklist
        if (task.ac && task.ac.length > 0) {
          markdown += `\n**AC:**\n`;
          for (const item of task.ac) {
            const checkbox = item.completed ? '[x]' : '[ ]';
            markdown += `- ${checkbox} ${item.text}\n`;
          }
        }

        // Verify checklist
        if (task.verify && task.verify.length > 0) {
          markdown += `\n**Verify:**\n`;
          for (const item of task.verify) {
            const checkbox = item.completed ? '[x]' : '[ ]';
            markdown += `- ${checkbox} ${item.text}\n`;
          }
        }

        // Files inline
        if (task.files) {
          markdown += `\n**Files:** ${task.files}\n`;
        }

        markdown += '\n';
      }
    }
    return markdown;
  }
}
