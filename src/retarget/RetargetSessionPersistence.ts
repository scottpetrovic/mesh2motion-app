import { AnimationRetargetService } from './AnimationRetargetService'
import type { Mesh2MotionEngine } from '../Mesh2MotionEngine'
import type { StepLoadSourceSkeleton } from './steps/StepLoadSourceSkeleton'
import type { StepLoadTargetModel } from './steps/StepLoadTargetModel'
import type { StepBoneMapping } from './steps/StepBoneMapping'

interface SavedRetargetSession {
  skeleton_selection: string
  bone_mappings: Record<string, string>
  saved_at: number
}

/**
 * Same idea as SessionPersistence on the create page, scoped to the retarget
 * page: source skeleton choice and bone mappings in localStorage, the
 * uploaded target model in IndexedDB.
 */
export class RetargetSessionPersistence {
  private static readonly state_key = 'mesh2motion-retarget-session'
  private static readonly db_name = 'mesh2motion-retarget-session'
  private static readonly db_store = 'files'

  private readonly engine: Mesh2MotionEngine
  private readonly source_skeleton_step: StepLoadSourceSkeleton
  private readonly target_model_step: StepLoadTargetModel
  private readonly bone_mapping_step: StepBoneMapping
  private is_restoring: boolean = false
  private pending_mappings: Record<string, string> | null = null

  constructor (
    engine: Mesh2MotionEngine,
    source_skeleton_step: StepLoadSourceSkeleton,
    target_model_step: StepLoadTargetModel,
    bone_mapping_step: StepBoneMapping
  ) {
    this.engine = engine
    this.source_skeleton_step = source_skeleton_step
    this.target_model_step = target_model_step
    this.bone_mapping_step = bone_mapping_step
  }

  public initialize (): void {
    this.target_model_step.addEventListener('target-model-loaded', () => {
      if (this.is_restoring) {
        this.apply_pending_mappings()
        return
      }
      void this.store_model_source()
      this.save_state()
    })

    this.source_skeleton_step.addEventListener('skeleton-loaded', () => {
      if (this.is_restoring) { return }
      this.save_state()
    })

    this.bone_mapping_step.addEventListener('bone-mappings-changed', () => {
      if (this.is_restoring) { return }
      this.save_state()
    })

    window.addEventListener('beforeunload', () => { this.save_state() })
  }

  public save_state (): void {
    if (this.is_restoring) { return }
    try {
      const session: SavedRetargetSession = {
        skeleton_selection: this.source_skeleton_step.current_skeleton_selection(),
        bone_mappings: Object.fromEntries(AnimationRetargetService.getInstance().get_bone_mappings()),
        saved_at: Date.now()
      }
      localStorage.setItem(RetargetSessionPersistence.state_key, JSON.stringify(session))
    } catch (error) {
      console.warn('Could not save retarget session', error)
    }
  }

  public async try_restore (): Promise<void> {
    let session: SavedRetargetSession | null = null
    try {
      const raw = localStorage.getItem(RetargetSessionPersistence.state_key)
      if (raw === null) { return }
      session = JSON.parse(raw) as SavedRetargetSession
    } catch {
      localStorage.removeItem(RetargetSessionPersistence.state_key)
      return
    }

    if (session === null) { return }

    this.is_restoring = true
    try {
      if (session.skeleton_selection !== '') {
        this.source_skeleton_step.restore_skeleton_selection(session.skeleton_selection)
      }

      const model = await this.read_model_source()
      if (model !== null && model.data !== null && model.data !== undefined) {
        this.pending_mappings = session.bone_mappings ?? null
        this.engine.load_model_step.set_source_file_name(model.file_name)
        this.target_model_step.load_target_model_from_data(model.data, model.extension)
      } else {
        this.is_restoring = false
      }
    } catch (error) {
      console.warn('Retarget session restore failed', error)
      this.is_restoring = false
    }
  }

  private apply_pending_mappings (): void {
    const mappings = this.pending_mappings
    this.pending_mappings = null

    if (mappings !== null && Object.keys(mappings).length > 0) {
      AnimationRetargetService.getInstance().set_bone_mappings(new Map(Object.entries(mappings)))
      this.bone_mapping_step.update_bone_lists()
      this.bone_mapping_step.dispatchEvent(new CustomEvent('bone-mappings-changed'))
    }

    this.is_restoring = false
    this.save_state()
  }

  private async open_db (): Promise<IDBDatabase> {
    return await new Promise((resolve, reject) => {
      const request = indexedDB.open(RetargetSessionPersistence.db_name, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(RetargetSessionPersistence.db_store)) {
          request.result.createObjectStore(RetargetSessionPersistence.db_store)
        }
      }
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error) }
    })
  }

  private async store_model_source (): Promise<void> {
    try {
      const source = this.engine.load_model_step.model_source_data()
      if (source.data === null) { return }
      const db = await this.open_db()
      db.transaction(RetargetSessionPersistence.db_store, 'readwrite')
        .objectStore(RetargetSessionPersistence.db_store).put(source, 'model')
      db.close()
    } catch (error) {
      console.warn('Could not store target model for retarget session', error)
    }
  }

  private async read_model_source (): Promise<{ data: string | ArrayBuffer | null, extension: string, file_name: string } | null> {
    try {
      const db = await this.open_db()
      return await new Promise((resolve) => {
        const request = db.transaction(RetargetSessionPersistence.db_store, 'readonly')
          .objectStore(RetargetSessionPersistence.db_store).get('model')
        request.onsuccess = () => { db.close(); resolve(request.result ?? null) }
        request.onerror = () => { db.close(); resolve(null) }
      })
    } catch {
      return null
    }
  }
}
