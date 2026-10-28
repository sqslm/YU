/** Only these reviewed public files may be fetched; no user URL or credentials. */
export const ENTITY_SOURCES = [
  { id: 'frost-names', name: '公共名称补充', description: '白霜拼音维护的名称词表，包含人物、角色等。', url: 'https://raw.githubusercontent.com/gaboolic/rime-frost/master/cn_dicts_cell/name.dict.yaml', project: 'https://github.com/gaboolic/rime-frost', license: 'GPL-3.0', format: 'rime', domain: '人物' },
  { id: 'frost-hot', name: '网络新词', description: '白霜拼音维护的网络热词、作品及品牌等。', url: 'https://raw.githubusercontent.com/gaboolic/rime-frost/master/cn_dicts_cell/exthot.dict.yaml', project: 'https://github.com/gaboolic/rime-frost', license: 'GPL-3.0', format: 'rime', domain: '热点' },
  { id: 'frost-computer', name: '技术新词', description: '白霜拼音维护的计算机、互联网与 AI 企业词条。', url: 'https://raw.githubusercontent.com/gaboolic/rime-frost/master/cn_dicts_cell/computer.dict.yaml', project: 'https://github.com/gaboolic/rime-frost', license: 'GPL-3.0', format: 'rime', domain: '技术' },
  { id: 'thuocl-it', name: '计算机常用词', description: '清华 THUOCL 较旧的技术词表，取原词频最高的 5000 项。', url: 'https://raw.githubusercontent.com/thunlp/THUOCL/master/data/THUOCL_IT.txt', project: 'https://github.com/thunlp/THUOCL', license: 'MIT', format: 'frequency', domain: '技术', limit: 5000 }
] as const
export type EntitySourceId = typeof ENTITY_SOURCES[number]['id']
