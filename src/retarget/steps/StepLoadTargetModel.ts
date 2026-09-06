import { type Bone, Box3, type Scene, type SkinnedMesh, Vector3 } from 'three'
import { type Mesh2MotionEngine } from '../../Mesh2MotionEngine.ts'
import { ModalDialog } from '../../lib/ModalDialog.ts'
import { MultiRootSkeletonResolver, type RootBoneChain } from '../MultiRootSkeletonResolver.ts'
import { RetargetUtils } from '../RetargetUtils.ts'
import { RootBoneSelectionDialog } from '../RootBoneSelectionDialog.ts'
import { TargetBoneTreeDialog } from '../TargetBoneTreeDialog.ts'

/**
 * Handles loading the target model (user-uploaded model) for retargeting
 */
export class StepLoadTargetModel extends EventTarget {
  private readonly mesh2motion_engine: Mesh2MotionEngine
  private readonly target_bone_tree_dialog: TargetBoneTreeDialog
  private readonly root_bone_selection_dialog: RootBoneSelectionDialog = new RootBoneSelectionDialog()
  private file_input: HTMLInputElement | null = null
  private load_model_button: HTMLLabelElement | null = null

  private retargetable_meshes: Scene | null = null

  constructor (mesh2motion_engine: Mesh2MotionEngine) {
    super()
    this.mesh2motion_engine = mesh2motion_engine
    this.target_bone_tree_dialog = new TargetBoneTreeDialog()
  }

  public begin (): void {
    this.add_event_listeners()
    this.target_bone_tree_dialog.begin()
  }

  public get_retargetable_meshes (): Scene | null {
    return this.retargetable_meshes
  }

  public get_first_skinned_mesh_bones (): Map<string, Bone> {
    const bones: Map<string, Bone> = new Map<string, Bone>()

    if (this.retargetable_meshes === null) {
      return bones
    }

    let first_skinned_mesh: SkinnedMesh | null = null
    this.retargetable_meshes.traverse((child) => {
      if (first_skinned_mesh === null && child.type === 'SkinnedMesh') {
        first_skinned_mesh = child as SkinnedMesh
      }
    })

    if (first_skinned_mesh === null) {
      return bones
    }

    first_skinned_mesh.skeleton.bones.forEach((bone) => {
      bones.set(bone.uuid, bone)
    })

    return bones
  }

  private add_event_listeners (): void {
    // Get DOM elements
    this.file_input = document.getElementById('upload-file') as HTMLInputElement
    this.load_model_button = document.getElementById('load-model-button') as HTMLLabelElement

    if (this.file_input === null) {
      console.error('Could not find file input element')
      return
    }

    // Add event listener for file selection
    this.file_input.addEventListener('change', (event) => {
      console.log('File input changed', event)
      this.handle_file_select(event)
    })
  }

  private handle_file_select (event: Event): void {
    const target = event.target as HTMLInputElement
    if (target.files !== null && target.files.length > 0) {
      const file = target.files[0]
      console.log('File selected:', file.name, 'Size:', file.size, 'Type:', file.type)

      // Get file extension
      const file_name: string = file.name.toLowerCase()

      // Determine the file extension and validate it
      let file_extension: string
      if (file_name.endsWith('.glb')) {
        file_extension = 'glb'
      } else if (file_name.endsWith('.fbx')) {
        file_extension = 'fbx'
      } else if (file_name.endsWith('.zip')) {
        file_extension = 'zip'
      } else {
        new ModalDialog('Unsupported file type. Please select a GLB, FBX, or ZIP file.', 'Error').show()
        return
      }

      this.mesh2motion_engine.load_model_step.set_source_file_name(file.name)

      const reader = new FileReader()
      reader.readAsDataURL(file)
      reader.onload = () => {
        this.load_target_model_from_data(reader.result, file_extension)
      }
    }
  }

  public load_target_model_from_data (data: string | ArrayBuffer | null, file_extension: string): void {
    // Configure the model loader to preserve all objects (bones, etc.)
    this.mesh2motion_engine.load_model_step.set_preserve_skinned_mesh(true)

    try {
      this.mesh2motion_engine.load_model_step.load_model_file(data, file_extension)

      this.mesh2motion_engine.load_model_step.addEventListener('modelLoadedForRetargeting', () => {
        console.log('Model loaded for retargeting successfully.')

        // read in mesh2motion engine's retargetable model data (this is the target)
        const retargetable_meshes: Scene = this.mesh2motion_engine.load_model_step.get_final_retargetable_model_data()
        const is_valid_skinned_mesh = RetargetUtils.validate_skinned_mesh_has_bones(retargetable_meshes)

        if (is_valid_skinned_mesh) {
          this.resolve_model_root_bones(retargetable_meshes).catch((error) => {
            console.error('Error resolving multiple skeletons in model:', error)
          })
        }
      }, { once: true })
    } catch (error) {
      console.error('Error loading model:', error)
      new ModalDialog('Error loading model file.', 'Error').show()
    }
  }

  /**
   * Some FBX files contain multiple disconnected bone hierarchies (multiple
   * root bones). Mesh2Motion only supports a single hierarchy, so the user is
   * asked which root bone is the main skeleton and everything else is removed.
   * Once the model has a single hierarchy, the regular retarget setup runs.
   */
  private async resolve_model_root_bones (retargetable_meshes: Scene): Promise<void> {
    if (MultiRootSkeletonResolver.has_multiple_root_bones(retargetable_meshes)) {
      const root_chains: RootBoneChain[] = MultiRootSkeletonResolver.find_root_bone_chains(retargetable_meshes)
      const chosen_root_uuid: string | null = await this.root_bone_selection_dialog.show(root_chains)

      if (chosen_root_uuid === null) {
        console.log('User cancelled import after being asked to choose a root bone')
        return
      }

      MultiRootSkeletonResolver.keep_single_root_bone(retargetable_meshes, chosen_root_uuid)

      // the extra hierarchies might have owned every skinned mesh
      if (!RetargetUtils.validate_skinned_mesh_has_bones(retargetable_meshes)) {
        console.warn('No skinned meshes remain after removing the extra skeletons')
        return
      }
    }

    this.process_retargetable_model(retargetable_meshes)
  }

  private process_retargetable_model (retargetable_meshes: Scene): void {
    // we have valid skinned mesh(s). The could be very large though,
    // we let's check to see how large everything is
    const bounding_box = new Box3().setFromObject(retargetable_meshes)
    const size = new Vector3()
    bounding_box.getSize(size)
    // console.log('Retargetable meshes bounding box size:', size)
    // console.log('Skinned mesh data to inspect:', retargetable_meshes)

    RetargetUtils.reset_skinned_mesh_to_rest_pose(retargetable_meshes)
    this.mesh2motion_engine.get_scene().add(retargetable_meshes)
    const largest_dimension: number = this.calculate_max_mesh_dimension(retargetable_meshes)

    // if the largest dimension is over 20, scale the entire scene down to be
    const target_height: number = 1.5 // in meters

    if (largest_dimension > 20 || largest_dimension < 0.1) {
      // calculate scale factor
      const scale_factor = target_height / largest_dimension
      console.log('scaling model down because of ', largest_dimension)
      new ModalDialog('Large Rig Warning',
        `The model you imported is large (${largest_dimension.toFixed(1)} meters). Mesh2Motion expects 1 unit = 1 meter. Your model will be scaled down. Mixamo rigs will work as long as they only have one skeleton in the model file.`).show()
      retargetable_meshes.scale.set(scale_factor, scale_factor, scale_factor) // common case with 3d creation tools that use 1 cm = 1 unit
    }

    // need to compare skeletons. for some reason the GLBs scale down fine, but the FBX bones are not looking right
    console.log('Final retargetable meshes after potential scaling:', retargetable_meshes)

    // Add skeleton helper
    this.add_skeleton_helper(retargetable_meshes)

    // Save the final retargetable meshes and dispatch event
    this.retargetable_meshes = retargetable_meshes
    this.target_bone_tree_dialog.set_target_bones(this.get_first_skinned_mesh_bones())
    this.target_bone_tree_dialog.set_target_skinned_mesh_count(this.get_target_skinned_mesh_count())
    this.dispatchEvent(new CustomEvent('target-model-loaded'))
  }

  private add_skeleton_helper (retargetable_meshes: Scene): void {
    retargetable_meshes.traverse((child) => {
      if (child.type === 'SkinnedMesh') {
        const skinned_mesh = child as SkinnedMesh
        this.mesh2motion_engine.regenerate_skeleton_helper(skinned_mesh.skeleton, 'Retarget Skeleton Helper')
      }
    })

    // the joint points are only meaningful while editing a skeleton, so keep
    // them off here and just show the bone shapes
    this.mesh2motion_engine.sync_skeleton_helper_joint_visibility()
  }

  private get_target_skinned_mesh_count (): number {
    let skinned_mesh_count = 0

    this.retargetable_meshes?.traverse((child) => {
      if (child.type === 'SkinnedMesh') {
        skinned_mesh_count++
      }
    })

    return skinned_mesh_count
  }

  // gets max dimension of the model for scaling
  // returns a unitless number representing the largest dimension
  private calculate_max_mesh_dimension (retargetable_meshes: Scene): number {
    const bounding_box = new Box3().setFromObject(retargetable_meshes)
    const size = new Vector3()
    bounding_box.getSize(size)
    return Math.max(size.x, size.y, size.z)
  }
}
