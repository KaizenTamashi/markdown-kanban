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
    let inTaskProperties = false;
    let inTaskDescription = false;
    let inCodeBlock = false;
    let activeListKey: ChecklistKey | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Skip HTML comment lines (e.g. <!-- next-id: N -->)
      if (trimmedLine.startsWith('<!--') && trimmedLine.endsWith('-->')) {
        continue;
      }

      // 检查代码块标记
      if (trimmedLine.startsWith('```')) {
        if (inTaskDescription) {
          if (trimmedLine === '```md' || trimmedLine === '```') {
            inCodeBlock = !inCodeBlock;
            continue;
          }
        }
      }

      // 如果在代码块内部，处理为描述内容
      if (inCodeBlock && inTaskDescription && currentTask) {
        if (trimmedLine === '```') {
          inCodeBlock = false;
          inTaskDescription = false;
          continue;
        } else {
          const cleanLine = line.replace(/^\s{4,}/, '');
          currentTask.description = currentTask.description
            ? currentTask.description + '\n' + cleanLine
            : cleanLine;
        }
        continue;
      }

      // 解析看板标题
      if (!inCodeBlock && trimmedLine.startsWith('# ') && !board.title) {
        board.title = trimmedLine.substring(2).trim();
        this.finalizeCurrentTask(currentTask, currentColumn);
        currentTask = null;
        inTaskProperties = false;
        inTaskDescription = false;
        activeListKey = null;
        continue;
      }

      // 解析列标题
      if (!inCodeBlock && trimmedLine.startsWith('## ')) {
        this.finalizeCurrentTask(currentTask, currentColumn);
        currentTask = null;
        if (currentColumn) {
          board.columns.push(currentColumn);
        }

        let columnTitle = trimmedLine.substring(3).trim();
        let isArchived = false;

        // 检查是否包含 [Archived] 标记
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
        inTaskProperties = false;
        inTaskDescription = false;
        activeListKey = null;
        continue;
      }

      // 解析任务标题
      if (!inCodeBlock && this.isTaskTitle(line, trimmedLine)) {
        this.finalizeCurrentTask(currentTask, currentColumn);

        if (currentColumn) {
          let taskTitle = '';

          if (trimmedLine.startsWith('### ')) {
            taskTitle = trimmedLine.substring(4).trim();
          } else {
            taskTitle = trimmedLine.substring(2).trim();
            // 移除复选框标记
            if (taskTitle.startsWith('[ ] ') || taskTitle.startsWith('[x] ')) {
              taskTitle = taskTitle.substring(4).trim();
            }
          }

          currentTask = {
            id: this.generateId(),
            title: taskTitle,
            description: ''
          };
          inTaskProperties = true;
          inTaskDescription = false;
          activeListKey = null;
        }
        continue;
      }

      // 解析任务属性
      if (!inCodeBlock && currentTask && inTaskProperties) {
        const parsedKey = this.parseTaskProperty(line, currentTask);
        if (parsedKey !== false) {
          // Track which checklist we're currently in
          if (parsedKey === 'steps' || parsedKey === 'ac' || parsedKey === 'verify') {
            activeListKey = parsedKey;
          } else {
            activeListKey = null;
          }
          continue;
        }

        // 解析 checklist 中的具体步骤项 (steps, ac, verify)
        if (this.parseChecklistItem(line, currentTask, activeListKey)) {
          continue;
        }

        // Legacy: support ```md code blocks for backward compatibility
        if (line.match(/^\s+```md/)) {
          inTaskProperties = false;
          inTaskDescription = true;
          inCodeBlock = true;
          activeListKey = null;
          continue;
        }

        // Recognize image markdown syntax as inline description (no wrapper needed)
        const imageMatch = trimmedLine.match(/^!\[.*\]\(.*\)/);
        if (imageMatch) {
          currentTask.description = currentTask.description
            ? currentTask.description + '\n' + trimmedLine
            : trimmedLine;
          continue;
        }

        // Continuation lines for desc: (indented lines that aren't properties/steps)
        if (currentTask.description !== undefined && line.match(/^\s{4,}/) && trimmedLine !== '') {
          currentTask.description = currentTask.description
            ? currentTask.description + '\n' + trimmedLine
            : trimmedLine;
          continue;
        }
      }

      // 处理空行
      if (trimmedLine === '') {
        continue;
      }

      // 结束当前任务
      if (!inCodeBlock && currentTask && (inTaskProperties || inTaskDescription)) {
        this.finalizeCurrentTask(currentTask, currentColumn);
        currentTask = null;
        inTaskProperties = false;
        inTaskDescription = false;
        activeListKey = null;
        i--;
      }
    }

    // 添加最后的任务和列
    this.finalizeCurrentTask(currentTask, currentColumn);
    if (currentColumn) {
      board.columns.push(currentColumn);
    }

    // Auto-assign TSK-N IDs to tasks that don't have one yet (uses counter, no scanning)
    for (const column of board.columns) {
      for (const task of column.tasks) {
        if (!task.id.match(/^TSK-\d+$/)) {
          task.id = `TSK-${board.nextId}`;
          board.nextId++;
        }
      }
    }

    return board;
  }

  private static isTaskTitle(line: string, trimmedLine: string): boolean {
    // 排除属性行和步骤项
    if (line.startsWith('- ') &&
        (trimmedLine.match(/^\s*- (id|due|tags|priority|workload|steps|defaultExpanded|desc|ac|verify|files):/) ||
         line.match(/^\s{6,}- \[([ x])\]/))) {
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
        // Inline text after `- desc:` starts the description
        if (value) {
          task.description = task.description
            ? task.description + '\n' + value
            : value;
        }
        break;
    }
    return propertyName;
  }

  private static parseChecklistItem(line: string, task: KanbanTask, listKey: ChecklistKey | null): boolean {
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
        if (taskHeaderFormat === 'title') {
          markdown += `### ${task.title}\n\n`;
        } else {
          markdown += `- ${task.title}\n`;
        }

        // 添加任务属性
        markdown += this.generateTaskProperties(task);

        // 添加描述
        if (task.description && task.description.trim() !== '') {
          const descriptionLines = task.description.trim().split('\n');
          if (descriptionLines.length === 1) {
            markdown += `  - desc: ${descriptionLines[0]}\n`;
          } else {
            markdown += `  - desc:\n`;
            for (const descLine of descriptionLines) {
              markdown += `    ${descLine}\n`;
            }
          }
        }

        markdown += '\n';
      }
    }
    return markdown;
  }

  private static generateTaskProperties(task: KanbanTask): string {
    let properties = '';

    if (task.id && task.id.match(/^TSK-\d+$/)) {
      properties += `  - id: ${task.id}\n`;
    }
    if (task.dueDate) {
      properties += `  - due: ${task.dueDate}\n`;
    }
    if (task.tags && task.tags.length > 0) {
      properties += `  - tags: [${task.tags.join(', ')}]\n`;
    }
    if (task.priority) {
      properties += `  - priority: ${task.priority}\n`;
    }
    if (task.workload) {
      properties += `  - workload: ${task.workload}\n`;
    }
    if (task.defaultExpanded) {
      properties += `  - defaultExpanded: true\n`;
    }
    if (task.steps && task.steps.length > 0) {
      properties += this.generateChecklistProperty('steps', task.steps);
    }
    if (task.ac && task.ac.length > 0) {
      properties += this.generateChecklistProperty('ac', task.ac);
    }
    if (task.verify && task.verify.length > 0) {
      properties += this.generateChecklistProperty('verify', task.verify);
    }
    if (task.files) {
      properties += `  - files: ${task.files}\n`;
    }

    return properties;
  }

  private static generateChecklistProperty(key: string, items: Array<{ text: string; completed: boolean }>): string {
    let output = `  - ${key}:\n`;
    for (const item of items) {
      const checkbox = item.completed ? '[x]' : '[ ]';
      output += `      - ${checkbox} ${item.text}\n`;
    }
    return output;
  }
}
