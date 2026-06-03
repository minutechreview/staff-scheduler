import { Component } from 'react'

export default class StoreScheduleBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Store schedule render failed', error, info)
  }

  componentDidUpdate(prevProps) {
    if (prevProps.storeId !== this.props.storeId && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="m-4 rounded-2xl border border-red-500/30 bg-red-950/20 px-5 py-4 text-red-100">
        <div className="text-sm font-semibold">This store schedule hit a display error.</div>
        <div className="mt-1 text-xs text-red-100/70">
          {this.state.error?.message || 'Unknown render error'}
        </div>
      </div>
    )
  }
}
