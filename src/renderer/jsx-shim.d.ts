import type { JSX as ReactJSX } from 'react'

// React 19 将 JSX 命名空间移入模块;为代码中直接使用的 JSX.Element 注解恢复全局声明
declare global {
  namespace JSX {
    type Element = ReactJSX.Element
    type ElementClass = ReactJSX.ElementClass
    type ElementAttributesProperty = ReactJSX.ElementAttributesProperty
    type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute
    type IntrinsicElements = ReactJSX.IntrinsicElements
  }
}

export {}
