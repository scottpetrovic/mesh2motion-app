import { UI } from '../../UI.ts'
import { Object3D, type Scene, type Object3DEventMap } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { SkeletonType, type HandSkeletonType } from '../../enums/SkeletonType.js'
import { RigConfig } from '../../RigConfig.ts'
import { DOMUtilities } from '../../DOMUtilities.ts'
import type GLTFResult from './interfaces/GLTFResult.ts'
import { add_origin_markers, remove_origin_markers } from './OriginMarkerManager'
import { add_preview_skeleton, remove_preview_skeleton } from './PreviewSkeletonManager.ts'
import { HandHelper } from './HandHelper.ts'

// Note: EventTarget is a built-ininterface and do not need to import it
export class StepLoadSkeleton extends EventTarget {
  private readonly loader: GLTFLoader = new GLTFLoader()
  private readonly ui: UI = UI.getInstance()
  private loaded_armature: Object3D = new Object3D()

  private _added_event_listeners: boolean = false
  private readonly _main_scene: Scene

  // used to help scale animations later
  // this is useful since position keyframes will need to be scaled
  // to prevent large offsets
  private skeleton_scale_percentage: number = 1.0

  // this was invented since this value is stored on a DOM element
  // this helps the marketing page set the type and doesn't rely on a DOM value
  // probably could refactor this a bit to be cleaner later.
  private manual_set_skeleton_type: SkeletonType = SkeletonType.None

  public skeleton_type (): SkeletonType {
    if (this.skeleton_file_path() === SkeletonType.None) {
      return this.manual_set_skeleton_type
    }

    return this.skeleton_file_path()
  }

  public set_skeleton_type (type: SkeletonType): void {
    this.manual_set_skeleton_type = type
  }

  // The edit skeleton step will use this to scale the skeleton when loading editable skeleton
  // animations listing will use this to scale all position keyframes
  public skeleton_scale (): number {
    return this.skeleton_scale_percentage
  }

  constructor (main_scene: Scene) {
    super()
    this._main_scene = main_scene
  }

  public begin (): void {
    if (this.ui.dom_current_step_element !== null) {
      this.ui.dom_current_step_element.innerHTML = 'Load Skeleton'
    }

    if (this.ui.dom_load_skeleton_tools !== null) {
      this.ui.dom_load_skeleton_tools.style.display = 'flex'
    }

    // if we are navigating back to this step, we don't want to add the event listeners again
    if (!this._added_event_listeners) {
      this.add_event_listeners()
      this._added_event_listeners = true
    }

    // when we come back to this step, there is a good chance we already selected a skeleton
    // so just use that and load the preview right when we enter this step
    if (!this.has_select_skeleton_ui_option()) {
      this.refresh_preview_skeleton().catch((err) => {
        console.error('error loading preview skeleton: ', err)
      })

    }

    // Initialize hand skeleton hand options visibility
    this.toggle_ui_hand_skeleton_options()

    // add origin markers for debugging model loading issues
    add_origin_markers(this._main_scene)

    // if there is a "select skeleton" option, disable proceeding
    // putting this check here helps us if we come back to this step later
    if (this.has_select_skeleton_ui_option()) {
      this.allow_proceeding_to_next_step(false)
    } else {
      this.allow_proceeding_to_next_step(true)
    }
  }

  public regenerate_origin_markers (): void {
    add_origin_markers(this._main_scene)
  }

  public dispose (): void {
    remove_origin_markers(this._main_scene)
    remove_preview_skeleton(this._main_scene)
  }

  private skeleton_file_path (): SkeletonType {
    // get currently selected option out of the model-selection drop-down
    const skeleton_selection = this.ui.dom_skeleton_drop_type.options
    const skeleton_file: string = skeleton_selection[skeleton_selection.selectedIndex].value

    if (skeleton_file === 'select-skeleton') return SkeletonType.None

    const config = RigConfig.by_key(skeleton_file)
    if (config === undefined) {
      console.error('unknown skeleton type selected: ', skeleton_file)
      return SkeletonType.Error
    }
    return config.skeleton_type
  }

  private hand_skeleton_type (): HandSkeletonType {
    const hand_selection = this.ui.dom_hand_skeleton_selection?.options
    return hand_selection[hand_selection.selectedIndex].value as HandSkeletonType
  }

  private add_event_listeners (): void {
    // Populate the skeleton template dropdown from the central rig config
    if (this.ui.dom_skeleton_drop_type !== null) {
      DOMUtilities.populate_skeleton_select(this.ui.dom_skeleton_drop_type)
    }

    // Add event listener for skeleton type changes to show/hide hand options
    if (this.ui.dom_skeleton_drop_type !== null) {
      this.ui.dom_skeleton_drop_type.addEventListener('change', () => {
        // get selected value from skeleton options
        // const skeleton_selection = this.ui.dom_skeleton_drop_type.options
        // this.skeleton_t = skeleton_selection[skeleton_selection.selectedIndex].value as SkeletonType

        // hand options only apply to human skeletons, so we need to show/hide when skeleton type changes
        this.toggle_ui_hand_skeleton_options()

        // remove the "select a skeleton" option if we picked something else
        if (this.has_select_skeleton_ui_option()) {
          this.ui.dom_skeleton_drop_type?.options.remove(0)
        }

        // show the scale skeleton options and advanced settings in case they are hidden
        if (this.ui.dom_scale_skeleton_controls !== null) {
          this.ui.dom_scale_skeleton_controls.style.display = 'flex'
        }
        // load the preview skeleton
        // need to get the file name for the correct skeleton
        // we pass the skeleton scale in the case where we set a skeleton, change scale, then change the skeleton
        this.refresh_preview_skeleton().then(() => {
          // enable the ability to progress to next step
          this.allow_proceeding_to_next_step(true)
        }).catch((err) => {
          console.error('error loading preview skeleton: ', err)
        })
      })
    }

    if (this.ui.dom_load_skeleton_button !== null) {
      this.ui.dom_load_skeleton_button.addEventListener('click', () => {
        if (this.ui.dom_skeleton_drop_type === null) {
          console.warn('could not find skeleton selection drop down HTML element')
          return
        }

        // add back loading information here
        const rig_file = RigConfig.rig_file_for(this.skeleton_file_path())
        if (rig_file !== undefined) {
          this.load_skeleton_file(rig_file)
        }
      })
    }// end if statement

    // when hand skeleton type changes. update the preview skeleton
    this.ui.dom_hand_skeleton_selection?.addEventListener('change', () => {
      // rebuild the preview skeleton with the new hand skeleton type
      // make sure we keep existing scale if we made a change to that
      this.refresh_preview_skeleton().catch((err) => {
        console.error('error loading preview skeleton: ', err)
      })
    })

    // scale skeleton controls
    this.ui.dom_scale_skeleton_input?.addEventListener('input', (event) => {
      // range sliders have rounding errors, so we round the value to avoid issues
      const new_value: number = Number((event.target as HTMLInputElement).value)
      this.update_skeleton_scale_to_value(new_value)
    })

    // reset the skeleton scale button
    this.ui.dom_reset_skeleton_scale_button?.addEventListener('click', () => {
      this.update_skeleton_scale_to_value(1.0)
    })

  }

  private update_skeleton_scale_to_value (new_value: number): void {
    this.skeleton_scale_percentage = Number(new_value)
    const display_value: string = Math.round(new_value * 100).toString() + '%'

    if (this.ui.dom_scale_skeleton_percentage_display !== null) {
      this.ui.dom_scale_skeleton_percentage_display.textContent = display_value
    }
    this.refresh_preview_skeleton()
      .catch((err) => {
        console.error('error loading preview skeleton: ', err)
      })
  }

  // the preview here is display only. The skeleton cannot be edited until the
  // edit skeleton step, so the joint points are turned off for every rebuild
  private async refresh_preview_skeleton (): Promise<Object3D<Object3DEventMap>> {
    return await add_preview_skeleton(this._main_scene, this.skeleton_file_path(),
      this.hand_skeleton_type(), this.skeleton_scale(), false)
  }

  public load_skeleton_file (file_path: string): void {
    // load skeleton from GLB file
    this.loader.load(file_path, (gltf: GLTFResult) => {
      // traverse scene and find first bone object
      // we will go to the parent and mark that as the original armature
      let armature_found = false
      let original_armature: Object3D = new Object3D()

      gltf.scene.traverse((child: Object3D) => {
        // Note: three.js removes punctuation characters from names object names like `-` and `.` for sanitization
        // Our 3D source files will need to account fo this if we are relying on that later for parsing
        // https://discourse.threejs.org/t/avoid-dots-and-colons-being-deleted-from-models-name/15304/2
        if (child.type === 'Bone' && !armature_found) {
          armature_found = true

          if (child.parent != null) {
            original_armature = child.parent
          } else {
            console.warn('could not find armature parent while loading skeleton')
          }
        }
      })

      this.loaded_armature = original_armature.clone()
      this.loaded_armature.name = 'Loaded Armature'

      // Apply hand skeleton modifications for human skeletons
      if (this.skeleton_file_path() === SkeletonType.Human) {
        const helper = new HandHelper()
        helper.modify_hand_skeleton(this.loaded_armature, this.hand_skeleton_type())
      }

      this.loaded_armature.position.set(0, 0, 0)
      this.loaded_armature.updateWorldMatrix(true, true)

      // scale the armature to what we picked using the scale slider/preview
      this.loaded_armature.scale.set(this.skeleton_scale(), this.skeleton_scale(), this.skeleton_scale())

      this.dispatchEvent(new CustomEvent('skeletonLoaded', { detail: this.loaded_armature }))
    })
  }

  // used by session restore to put the UI and internal state back the way the
  // user had it before loading the skeleton file
  public restore_skeleton_selection (skeleton_type: SkeletonType, hand_type: string, scale: number): void {
    if (this.ui.dom_skeleton_drop_type !== null) {
      if (this.has_select_skeleton_ui_option()) {
        this.ui.dom_skeleton_drop_type.options.remove(0)
      }
      this.ui.dom_skeleton_drop_type.value = skeleton_type
    }

    if (this.ui.dom_hand_skeleton_selection !== null && hand_type !== '') {
      this.ui.dom_hand_skeleton_selection.value = hand_type
    }

    this.manual_set_skeleton_type = skeleton_type
    this.skeleton_scale_percentage = scale

    if (this.ui.dom_scale_skeleton_input !== null) {
      this.ui.dom_scale_skeleton_input.value = String(scale)
    }
    if (this.ui.dom_scale_skeleton_percentage_display !== null) {
      this.ui.dom_scale_skeleton_percentage_display.textContent = Math.round(scale * 100).toString() + '%'
    }
    if (this.ui.dom_scale_skeleton_controls !== null) {
      this.ui.dom_scale_skeleton_controls.style.display = 'flex'
    }

    this.toggle_ui_hand_skeleton_options()
  }

  private has_select_skeleton_ui_option (): boolean {
    return this.ui.dom_skeleton_drop_type?.options[0].value === 'select-skeleton'
  }

  private allow_proceeding_to_next_step (allow: boolean): void {
    const btn = this.ui.dom_load_skeleton_button as HTMLButtonElement | null
    if (!btn) return
    btn.disabled = !allow // disable when not allowed
  }

  // returns a skeleton object that has been baked (applied) for scale
  public armature (): Object3D<Object3DEventMap> {
    return this.bake_scale_for_armature(this.loaded_armature)
  }

  // this does not mutate armature that goes in
  // bakes scale into bone positions and resets scale to 1
  private bake_scale_for_armature (armature: Object3D): Object3D {
    const scale = armature.scale.x // assumes uniform scale

    const cloned_armature: Object3D = armature.clone()

    // bake scale into all child bone positions
    if (scale !== 1) {
      cloned_armature.traverse((obj) => {
        if (obj instanceof Object3D && obj !== cloned_armature) {
          obj.position.multiplyScalar(scale)
        }
      })
      cloned_armature.scale.set(1, 1, 1)
    }

    cloned_armature.updateMatrixWorld(true)
    return cloned_armature
  }

  private toggle_ui_hand_skeleton_options (): void {
    if (this.ui.dom_skeleton_drop_type === null || this.ui.dom_hand_skeleton_options === null) {
      return
    }

    if (this.skeleton_file_path() === SkeletonType.Human) {
      this.ui.dom_hand_skeleton_options.style.display = 'flex'
    } else {
      this.ui.dom_hand_skeleton_options.style.display = 'none'
    }
  }
}
