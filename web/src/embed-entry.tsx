import { createRoot } from 'react-dom/client'
import { CreatureField } from './CreatureField.js'
import './styles.css'
import './embed.css'

/**
 * 主站嵌入入口(embed.html):只渲染四周游走的生灵层,透明背景。
 * 与 index.html 共用 CreatureField;被 zxlumen.cn 以 pointer-events:none 的
 * 全屏 iframe 嵌入,让 Top5 生灵出现在主站内容周围。
 */
const el = document.getElementById('root')
if (el) createRoot(el).render(<CreatureField />)
