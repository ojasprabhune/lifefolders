import { useState } from 'react'
import { pickQuip } from './greetings'

export function Quip({ domain }: { domain: string }) {
  const [quip] = useState(() => pickQuip(domain))
  if (!quip) return null
  return <span className="panel-quip">{quip}</span>
}
