export type SettingMeta = {
  key: string;
  title: string;
  icon: string;
  requireAdmin: boolean;
  keywords?: string[];
};

export const allSettingMetas: SettingMeta[] = [
  {
    key: 'basic',
    title: 'basic-information',
    icon: 'tabler:tool',
    requireAdmin: false,
    keywords: ['basic', 'information', '基本信息', '基础设置'],
  },
  {
    key: 'prefer',
    title: 'preference',
    icon: 'tabler:settings-2',
    requireAdmin: false,
    keywords: ['preference', 'theme', 'language', '偏好设置', '主题', '语言'],
  },
  {
    key: 'storage',
    title: 'storage',
    icon: 'tabler:database',
    requireAdmin: true,
    keywords: ['storage', 'database', '存储', '数据库'],
  },
  {
    key: 'export',
    title: 'backup-and-restore',
    icon: 'tabler:file-export',
    requireAdmin: false,
    keywords: ['export', 'import', 'backup', 'restore', 'data', '导出', '导入', '备份', '恢复', '数据导出'],
  },
  {
    key: 'operationLog',
    title: 'operation-log',
    icon: 'lucide:history',
    requireAdmin: false,
    keywords: ['operation', 'log', 'history', '操作日志', '审计', '变更'],
  },
  {
    key: 'about',
    title: 'about',
    icon: 'tabler:info-circle',
    requireAdmin: false,
    keywords: ['about', 'information', '关于', '信息'],
  },
];
