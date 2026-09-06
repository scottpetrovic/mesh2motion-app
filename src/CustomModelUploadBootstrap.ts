import { Mesh2MotionEngine } from './Mesh2MotionEngine'
import { SessionPersistence } from './lib/persistence/SessionPersistence'

export class CustomModelUploadBootstrap {
  private readonly mesh2motion_engine: Mesh2MotionEngine
  private readonly session_persistence: SessionPersistence

  constructor () {
    this.mesh2motion_engine = new Mesh2MotionEngine()
    this.session_persistence = new SessionPersistence(this.mesh2motion_engine)
    this.mesh2motion_engine.session_persistence = this.session_persistence
    this.session_persistence.initialize()
    void this.session_persistence.try_restore()
  }
}

// instantiate the class to setup event listeners
const app = new CustomModelUploadBootstrap()
