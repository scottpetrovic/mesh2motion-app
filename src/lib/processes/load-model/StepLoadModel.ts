import { UI } from '../../UI.ts'
import { ModelZipLoader } from './ModelZipLoader.ts'
import { CustomFBXLoader, type FBXResults } from './CustomFBXLoader.ts'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DOMUtilities } from '../../DOMUtilities.ts'

import { Scene } from 'three/src/scenes/Scene.js'
import { Mesh } from 'three/src/objects/Mesh.js'
import { BufferGeometry, Group, type Material, type Object3D } from 'three'
import { ModalDialog } from '../../ModalDialog.ts'
import { Utility } from '../../Utilities.ts'
import { ModelCleanupUtility } from './ModelCleanupUtility.ts'
import { ModelAnalysisReport, type ModelImportAnalysis, type SceneSnapshot } from './ModelAnalysisReport.ts'
import { PlatformUtils } from '../../PlatformUtils.ts'

// Note: EventTarget is a built-ininterface and do not need to import it
export class StepLoadModel extends EventTarget {
  private readonly gltf_loader = new GLTFLoader()
  private readonly custom_fbx_loader: CustomFBXLoader = new CustomFBXLoader()
  private readonly ui: UI = UI.getInstance()
  private original_model_data: Scene | Group = new Scene()
  private final_mesh_data: Scene = new Scene() // mesh data used when creating the skinned mesh

  // model data used for retargeting process. Only used during retargeting processes
  private final_retargetable_model_data: Scene = new Scene()
  private debug_model_loading: boolean = false

  private model_display_name: string = 'Imported Model'

  // file the user picked, only used for labeling the analysis report
  private source_file_name: string = 'Unknown file'

  // kept so a session restore can re-feed the exact same input to load_model_file
  private source_file_data: string | ArrayBuffer | null = null
  private source_file_extension: string = ''

  // diagnostic snapshot of what the file contained vs. what import produced
  private import_analysis: ModelImportAnalysis | null = null

  // there can be multiple objects in a model, so store them in a list
  private readonly geometry_list: BufferGeometry[] = []
  private readonly material_list: Material[] = []

  private _added_event_listeners: boolean = false

  // this can happen when images are not loading. this
  // will mess up model and need to just replace the entire material
  private mesh_has_broken_material: boolean = false

  // controls whether to preserve all objects (bones, lights, etc.) or strip to meshes only
  private preserve_skinned_mesh: boolean = false

  // for debugging, let's count these to help us test performance things better
  vertex_count = 0
  triangle_count = 0
  objects_count = 0

  private original_geometry_positions: Float32Array[] = []

  /**
   * Skinned mesh data that will be used for retargeting
   * @returns Loaded Skinned mesh data that will be used for retargeting
   */
  public get_final_retargetable_model_data (): Scene {
    return this.final_retargetable_model_data
  }

  private calculate_geometry_and_materials (scene_to_analyze: Scene): void {
    // clear geometry and material list in case we run this again
    // this empties the array in place, and doesn't need to create a new array
    this.geometry_list.length = 0
    this.material_list.length = 0

    scene_to_analyze.traverse((child: Object3D) => {
      if (child.type === 'Mesh') {
        const geometry_to_add: BufferGeometry = ModelCleanupUtility.build_geometry_list_from_mesh(child as Mesh)
        this.geometry_list.push(geometry_to_add)

        // material is broken somehow, so just use a normal material to help communicate this
        if (this.mesh_has_broken_material) {
          this.material_list.push(ModelCleanupUtility.create_fallback_material())
          return
        }

        // handle multiple materials (array) or single material
        if (Array.isArray((child as Mesh).material)) {
          // clone each material in the array and preserve array structure
          const materials = (child as Mesh).material as Material[]
          const cloned_materials = materials.map(mat => mat.clone())
          this.material_list.push(cloned_materials as any)
        } else {
          // single material case
          const new_material: Material = ((child as Mesh).material as Material).clone()
          this.material_list.push(new_material)
        }
      }
    })
  }

  public begin (): void {
    if (this.ui.dom_current_step_element !== null) {
      this.ui.dom_current_step_element.innerHTML = 'Load Model'
    }

    if (this.ui.dom_load_model_tools !== null) {
      this.ui.dom_load_model_tools.style.display = 'flex'
    }

    // if we are navigating back to this step, we don't want to add the event listeners again
    if (!this._added_event_listeners) {
      this.add_event_listeners()
      this._added_event_listeners = true
    }
  }

  public add_event_listeners (): void {
    // Populate the model reference dropdown from the central rig config
    const model_select = document.querySelector<HTMLSelectElement>('#model-selection')
    if (model_select !== null) {
      DOMUtilities.populate_model_select(model_select)
    }

    if (this.ui.dom_upload_model_button !== null) {
      // handle file upload
      this.ui.dom_upload_model_button.addEventListener('change', (event: Event) => {
        const file = event.target.files[0]
        const file_extension: string = Utility.get_file_extension(file.name)
        this.source_file_name = file.name

        const reader = new FileReader()
        reader.readAsDataURL(file)
        reader.onload = () => {
          console.log('File reader loaded', reader)
          this.load_model_file(reader.result, file_extension)
        }
      })

      // iOS has a weird issue with accepted file extensions, so we need to just
      // accept everything for that platform
      if (PlatformUtils.isIOS()) {
        this.ui.dom_upload_model_button.setAttribute('accept', '*/*')
      }
    }

    if (this.ui.dom_load_model_debug_checkbox !== null) {
      this.ui.dom_load_model_debug_checkbox.addEventListener('change', (event: Event) => {
        const debug_mode = event.target.checked
        this.debug_model_loading = debug_mode
      })
    }

    if (this.ui.dom_load_model_button !== null) {
      this.ui.dom_load_model_button.addEventListener('click', () => {
        // get currently selected option out of the model-selection drop-down
        const model_selection = document.querySelector('#model-selection')

        if (model_selection !== null) {
          const file_name = model_selection.options[model_selection.selectedIndex].value
          const file_extension: string = Utility.get_file_extension(file_name)
          this.source_file_name = file_name.split('/').pop() ?? file_name
          this.load_model_file(file_name, file_extension)
        }
      })
    }
  }

  public model_source_data (): { data: string | ArrayBuffer | null, extension: string, file_name: string } {
    return {
      data: this.source_file_data,
      extension: this.source_file_extension,
      file_name: this.source_file_name
    }
  }

  public set_source_file_name (name: string): void {
    this.source_file_name = name
  }

  public clear_loaded_model_data (): void {
    this.original_model_data = new Scene()
    this.final_mesh_data = new Scene()
    this.geometry_list.length = 0
    this.material_list.length = 0
    this.original_geometry_positions = []
    this.vertex_count = 0
    this.triangle_count = 0
    this.objects_count = 0
    this.mesh_has_broken_material = false
    this.preserve_skinned_mesh = false
    this.import_analysis = null
  }

  public reset_model_position (): void {
    let i = 0
    this.final_mesh_data.traverse((obj: Object3D) => {
      if (obj.type === 'Mesh') {
        const mesh = obj as Mesh
        const attr = mesh.geometry.attributes.position
        const original = this.original_geometry_positions[i++]
        if (original !== undefined) {
          ;(attr.array as Float32Array).set(original)
          attr.needsUpdate = true
          mesh.geometry.computeBoundingBox()
          mesh.geometry.computeBoundingSphere()
        }
      }
    })
    this.final_mesh_data.position.set(0, 0, 0)
  }

  /**
   *
   * @param preserve
   */
  public set_preserve_skinned_mesh (preserve: boolean): void {
    this.preserve_skinned_mesh = preserve
  }

  public load_model_file (model_file_path: string | ArrayBuffer | null, file_extension: string): void {
    this.source_file_data = model_file_path
    this.source_file_extension = file_extension

    // only the FBX loader can flag this, so clear it here or a previous broken FBX
    // would keep forcing the fallback material onto every model loaded after it
    this.mesh_has_broken_material = false

    if (file_extension === 'fbx') {
      this.load_fbx_file(model_file_path)
    } else if (file_extension === 'glb') {
      this.gltf_loader.load(model_file_path as string, (gltf) => {
        const loaded_scene: Scene = gltf.scene
        this.process_loaded_scene(loaded_scene)
      })
    } else if (file_extension === 'zip') {
      console.log('ZIP file can contain GLTF+BIN model data')
      this.handle_zip_file(model_file_path)
    } else {
      console.error('Unsupported file format to load. Only acccepts FBX, (ZIP)GLTF+BIN, GLB:', model_file_path)
    }
  }

  private load_fbx_file (model_file_path: string | ArrayBuffer | null): void {
    if (typeof model_file_path !== 'string') {
      console.warn('something weird happened and FBX is being loaded that is not a filepath for a string:', model_file_path)
      return
    }

    // console.log('Loading FBX model:', model_file_path)
    this.custom_fbx_loader.loadFBX(model_file_path).then((results: FBXResults) => {
      console.log('loaded the FBX file', results)
      this.mesh_has_broken_material = results.is_missing_dependencies
      const loaded_scene: Scene = new Scene()

      // TODO: add the processed, cleaned up data instead of the fbx_scene directly
      loaded_scene.add(results.fbx_scene)

      this.process_loaded_scene(loaded_scene)
    }).catch((error) => {
      console.warn('some type of error', error)
    })
  }

  /**
   * Handles loading a model from a ZIP file with GLTF data
   * supporting both data URLs and ArrayBuffer input.
   */
  private handle_zip_file (model_file_path: string | ArrayBuffer | null): void {
    const zip_loader = new ModelZipLoader()

    // internal async function that loads the ZIP from an ArrayBuffer
    const handle_zip = async (buffer: ArrayBuffer): Promise<void> => {
      try {
        const scene = await zip_loader.loadModelFromZip(buffer)
        console.log('Model loaded from ZIP:', scene)
        this.process_loaded_scene(scene)
      } catch (err) {
        // if no GLTF file found, or other error, show dialog
        console.error('Failed to load model from ZIP:', err)
        new ModalDialog('Failed to load model from ZIP: ', err?.message || err).show()
      }
    }

    // load in the zip and send the array buffer data to the loader
    if (typeof model_file_path === 'string' && model_file_path.startsWith('data:')) {
      fetch(model_file_path)
        .then(async res => await res.arrayBuffer()) // convert to ArrayBuffer for processing
        .then(buffer => handle_zip(buffer).catch((err) => {
          const msg = (err && typeof err === 'object' && 'message' in err) ? err.message : String(err)
          console.error('Failed to load model from ZIP:', err)
          new ModalDialog('Failed to load model from ZIP: ', msg).show()
        }))
        .catch((err) => {
          const msg = (err && typeof err === 'object' && 'message' in err) ? err.message : String(err)
          console.error('Failed to fetch ZIP data:', err)
          new ModalDialog('Failed to fetch ZIP data: ', msg).show()
        })
    } else {
      // ZIP file is corrupted??
      const msg = 'ZIP file data is not in a supported format'
      console.error(msg)
      new ModalDialog('ZIP file error decompressing: ', msg).show()
    }
  }

  private process_loaded_scene (loaded_scene: Scene): void {
    // capture the file contents before any cleanup/normalization runs. this has to
    // happen first because the steps below mutate geometry that is shared with the
    // scene the loader handed us
    const imported_snapshot: SceneSnapshot = ModelAnalysisReport.snapshot_scene(loaded_scene)

    if (this.preserve_skinned_mesh) {
      this.original_model_data = loaded_scene
    } else {
      this.original_model_data = loaded_scene.clone()
      this.original_model_data.name = 'Cloned Scene'
    }

    this.original_model_data.traverse((child) => {
      child.castShadow = true
    })

    // strip out things differently if we need to preserve skinned meshes or regular meshes
    let clean_scene_with_only_models: Scene
    if (this.preserve_skinned_mesh) {
      // need to be careful with cleaning up and skeleton data. it can break the hierarchy
      // and mess up the skinned mesh and exports. So for now, just keep everything
      clean_scene_with_only_models = this.original_model_data
    } else {
      // bake object transforms into the vertices before flattening the hierarchy.
      // stripping and rebuilding meshes below drops object transforms entirely, so
      // this is what keeps the orientation, placement, and scale from the file.
      // skipped for skinned meshes, where baking would break the skeleton binding
      ModelCleanupUtility.bake_transforms_into_geometry(this.original_model_data)
      clean_scene_with_only_models = ModelCleanupUtility.strip_out_all_unecessary_model_data(this.original_model_data, this.model_display_name, this.debug_model_loading)
    }

    // if there are no valid mesh, or skinned mesh, show error dialog
    if (clean_scene_with_only_models.children.length === 0) {
      if (this.preserve_skinned_mesh) {
        new ModalDialog('Error loading model', 'No SkinnedMesh found in model file for retargeting').show()
      } else {
        new ModalDialog('Error loading model', 'No Mesh found in model file').show()
      }
      return
    }

    // if we are doing retargeting, our work ends here for loading the model
    // assign the final retargetable model data to the cleaned scene with skinned meshes
    // any scaling or further processing can be donw as part of the retargeting process
    if (this.preserve_skinned_mesh) {
      this.final_retargetable_model_data = clean_scene_with_only_models

      // the non-skinned path does this inside calculate_geometry_and_materials(), which
      // we never reach here, so apply the same fallback material directly on the meshes
      if (this.mesh_has_broken_material) {
        ModelCleanupUtility.replace_materials_with_fallback(this.final_retargetable_model_data)
      }

      this.import_analysis = this.build_import_analysis(imported_snapshot, this.final_retargetable_model_data)
      this.dispatchEvent(new CustomEvent('modelLoadedForRetargeting'))
      return
    }

    // every transform is already baked into the geometry at this point, so the
    // skinning process sees the identity transforms it needs. just make sure the
    // matrices are current for the bounding box calculations below
    clean_scene_with_only_models.updateMatrixWorld(true)

    // Some objects come in very large, which makes it harder to work with
    // scale everything down to a max height. mutate the clean scene object
    ModelCleanupUtility.scale_model_on_import_if_extreme(clean_scene_with_only_models)

    // preserved skinned meshes shouldn't be breaking apart mesh data
    // breaking apart skinned meshes converts it to a regular mesh which we don't want.
    this.calculate_geometry_and_materials(clean_scene_with_only_models)

    // this needs to happen after calculate_geometry_and_materials
    const mesh_metrics = ModelCleanupUtility.calculate_mesh_metrics(this.geometry_list)
    this.vertex_count = mesh_metrics.vertex_count
    this.triangle_count = mesh_metrics.triangle_count
    this.objects_count = mesh_metrics.objects_count
    console.log(`Vertex count:${this.vertex_count}    Triangle Count:${this.triangle_count} Object Count:${this.objects_count} `)

    // assign the final cleaned up model to the original model data
    this.final_mesh_data = this.model_meshes()

    // snapshot vertex positions so we can reset later
    this.original_geometry_positions = []
    this.final_mesh_data.traverse((obj: Object3D) => {
      if (obj.type === 'Mesh') {
        const positions = (obj as Mesh).geometry.attributes.position.array as Float32Array
        this.original_geometry_positions.push(new Float32Array(positions))
      }
    })

    console.log('final mesh data should be prepared at this point', this.final_mesh_data)

    this.import_analysis = this.build_import_analysis(imported_snapshot, this.final_mesh_data)

    this.dispatchEvent(new CustomEvent('modelLoaded'))
  }

  private build_import_analysis (imported_snapshot: SceneSnapshot, processed_scene: Scene): ModelImportAnalysis {
    return {
      source_name: this.source_file_name,
      imported: imported_snapshot,
      processed: ModelAnalysisReport.snapshot_scene(processed_scene)
    }
  }

  /**
   * Diagnostic breakdown of the last import, or null if nothing is loaded yet.
   * Used by the "Analyze" option to help troubleshoot odd looking models.
   */
  public get_import_analysis (): ModelImportAnalysis | null {
    return this.import_analysis
  }

  public model_meshes (): Scene {
    // if the scene has some children in it, that means we already built it
    // this function gets called when we enter the application
    if (this.final_mesh_data.children.length > 0) {
      return this.final_mesh_data
    }

    // create a new scene object, and only include meshes
    const new_scene = new Scene()
    new_scene.name = this.model_display_name

    // do a for loop to add all the meshes to the scene from the geometry and material list
    for (let i = 0; i < this.geometry_list.length; i++) {
      const mesh = new Mesh(this.geometry_list[i], this.material_list[i])
      new_scene.add(mesh)
    }

    this.final_mesh_data = new_scene

    return this.final_mesh_data
  }

  public models_geometry_list (): BufferGeometry[] {
    // loop through final mesh data and return the geometeries
    const geometries_to_return: BufferGeometry[] = []
    this.final_mesh_data.traverse((child) => {
      if (child.type === 'Mesh') {
        geometries_to_return.push((child as Mesh).geometry.clone())
      }
    })

    return geometries_to_return
  }

  public models_material_list (): Material[] {
    return this.material_list
  }
}
